import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { createProvider, upsertModel } from "../../core/providers.js";
import { appendJournalEntry, writeMemory } from "../../core/journal.js";
import { agentJournalHash } from "../../core/memory.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "PATH"];
const savedEnv = {};
const tempDirs = [];

describe("agents CRUD", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-claude-code-token";
    process.env.CODEX_API_KEY = "test-codex-key";
    const binDir = mkdtempSync(join(tmpdir(), "worklab-agent-bin-"));
    tempDirs.push(binDir);
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\necho 'codex-cli 0.125.0'\n");
    chmodSync(join(binDir, "claude"), 0o755);
    chmodSync(join(binDir, "codex"), 0o755);
    process.env.PATH = `${binDir}:${savedEnv.PATH || ""}`;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/agents returns []", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/agents").expect(200);
    expect(res.body).toEqual({ agents: [] });
  });

  it("GET /api/agents returns compact run stats without log events", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    await agent.post("/api/agents").send({
      name: "stats-agent",
      display_name: "Stats Agent",
      model: "claude:claude-sonnet-4-6",
    }).expect(201);
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("stats-task", "Stats task", now, now);
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, stage, agent_name, status, process_status, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("stats-run-1", "stats-task", "execute", "execute", "stats-agent", "complete", "succeeded", now - 2000, now - 1000);
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, stage, agent_name, status, process_status, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("stats-run-2", "stats-task", "execute", "execute", "stats-agent", "complete", "succeeded", now - 1000, now);
    db.prepare(`
      INSERT INTO agent_logs
        (id, task_run_id, events, model, duration_ms, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("stats-log-1", "stats-run-1", "x".repeat(4096), "claude:claude-sonnet-4-6", 1000, "complete", now);
    db.prepare(`
      INSERT INTO agent_logs
        (id, task_run_id, events, model, duration_ms, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("stats-log-2", "stats-run-2", "x".repeat(4096), "claude:claude-sonnet-4-6", 3000, "complete", now);

    const res = await agent.get("/api/agents").expect(200);
    const statsAgent = res.body.agents.find((row) => row.name === "stats-agent");

    expect(statsAgent).toMatchObject({
      last_run_at: now - 1000,
      run_count_30d: 2,
      avg_run_duration_ms: 2000,
    });
    expect(statsAgent.events).toBeUndefined();
  });

  it("GET /api/agents?view=summary omits heavy editable agent fields", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    const largeInstructions = "keep this out of startup payloads ".repeat(5000);
    db.prepare(`
      INSERT INTO agents
        (name, display_name, sdk, model, effort, instructions,
         skills_allowlist, mcp_allowlist, builtin_allowlist, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "summary-agent",
      "Summary Agent",
      "claude",
      "claude:claude-sonnet-4-6",
      "medium",
      largeInstructions,
      JSON.stringify(["worklab", "github"]),
      JSON.stringify(["context-a8c"]),
      JSON.stringify(["apply_patch"]),
      now,
      now,
    );

    const res = await agent.get("/api/agents?view=summary").expect(200);
    const summaryAgent = res.body.agents.find((row) => row.name === "summary-agent");

    expect(summaryAgent).toMatchObject({
      name: "summary-agent",
      display_name: "Summary Agent",
      model: "claude:claude-sonnet-4-6",
      enabled: true,
    });
    expect(summaryAgent.instructions).toBeUndefined();
    expect(summaryAgent.skills_allowlist).toBeUndefined();
    expect(summaryAgent.mcp_allowlist).toBeUndefined();
    expect(summaryAgent.builtin_allowlist).toBeUndefined();
    await agent.get("/api/agents?view=nope").expect(400);
  });

  it("POST /api/agents creates with required fields", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" }).expect(201);
    expect(res.body.agent.name).toBe("coder");
    expect(res.body.agent.enabled).toBe(true);
    expect(res.body.agent.effort).toBe("medium");
    expect(res.body.agent.allow_self_review).toBe(true);
    expect(res.body.agent.browser_tools_review_only).toBe(false);
    expect(res.body.agent.subagent_mode).toBe("advisory");
    expect(res.body.agent.daily_budget_usd).toBeUndefined();
    expect(res.body.agent.per_run_budget_usd).toBeUndefined();
  });

  it("defaults execution_mode to 'sdk' on POST and accepts 'cli'", async () => {
    const { agent, db } = makeTestServer();
    const def = await agent.post("/api/agents").send({ name: "default-mode", display_name: "Default", model: "claude:claude-sonnet-4-6" }).expect(201);
    expect(def.body.agent.execution_mode).toBe("sdk");
    const cli = await agent.post("/api/agents").send({ name: "cli-mode", display_name: "Cli", model: "claude:claude-sonnet-4-6", execution_mode: "cli" }).expect(201);
    expect(cli.body.agent.execution_mode).toBe("cli");
    const row = db.prepare("SELECT execution_mode FROM agents WHERE name = 'cli-mode'").get();
    expect(row.execution_mode).toBe("cli");
  });

  it("rejects invalid execution_mode on POST", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/agents").send({ name: "bogus", display_name: "B", model: "claude:claude-sonnet-4-6", execution_mode: "wat" }).expect(400);
    expect(res.body.error.code).toBe("validation");
  });

  it("PATCH updates execution_mode", async () => {
    const { agent, db } = makeTestServer();
    await agent.post("/api/agents").send({ name: "mover", display_name: "Mover", model: "claude:claude-sonnet-4-6" }).expect(201);
    const patched = await agent.patch("/api/agents/mover").send({ execution_mode: "cli" }).expect(200);
    expect(patched.body.agent.execution_mode).toBe("cli");
    const row = db.prepare("SELECT execution_mode FROM agents WHERE name = 'mover'").get();
    expect(row.execution_mode).toBe("cli");
  });

  it("defaults fast_mode on for Codex GPT agents and allows disabling it", async () => {
    const { agent, db } = makeTestServer();
    const created = await agent.post("/api/agents").send({
      name: "fast-codex",
      display_name: "Fast Codex",
      model: "codex:gpt-5.4-mini",
      execution_mode: "cli",
    }).expect(201);
    expect(created.body.agent.fast_mode).toBe(true);
    expect(db.prepare("SELECT fast_mode FROM agents WHERE name = 'fast-codex'").get().fast_mode).toBe(1);

    const disabled = await agent.patch("/api/agents/fast-codex").send({ fast_mode: false }).expect(200);
    expect(disabled.body.agent.fast_mode).toBe(false);
    expect(db.prepare("SELECT fast_mode FROM agents WHERE name = 'fast-codex'").get().fast_mode).toBe(0);
  });

  it("rejects explicit fast_mode for non-Codex-GPT agents but treats saved defaults as ineffective", async () => {
    const { agent, db } = makeTestServer();
    const piCodex = await agent.post("/api/agents").send({
      name: "pi-fast",
      display_name: "Pi Fast",
      model: "pi:openai-codex:gpt-5.5",
      execution_mode: "sdk",
      fast_mode: true,
    }).expect(400);
    expect(piCodex.body.error.code).toBe("invalid_fast_mode");

    await agent.post("/api/agents").send({
      name: "codex-to-claude",
      display_name: "Codex To Claude",
      model: "codex:gpt-5.5",
      execution_mode: "cli",
    }).expect(201);
    expect(db.prepare("SELECT fast_mode FROM agents WHERE name = 'codex-to-claude'").get().fast_mode).toBe(1);

    const patched = await agent.patch("/api/agents/codex-to-claude").send({
      model: "claude:claude-sonnet-4-6",
      execution_mode: "cli",
    }).expect(200);
    expect(patched.body.agent.fast_mode).toBe(false);
    expect(db.prepare("SELECT fast_mode FROM agents WHERE name = 'codex-to-claude'").get().fast_mode).toBe(1);
  });

  it("accepts 1M context only for eligible Opus Claude agents", async () => {
    const { agent, db } = makeTestServer();
    const created = await agent.post("/api/agents").send({
      name: "opus-long",
      display_name: "Opus Long",
      model: "claude:claude-opus-4-7",
      execution_mode: "cli",
      context_window: "1m",
    }).expect(201);
    expect(created.body.agent.context_window).toBe("1m");
    const row = db.prepare("SELECT context_window FROM agents WHERE name = 'opus-long'").get();
    expect(row.context_window).toBe("1m");

    const opus46 = await agent.post("/api/agents").send({
      name: "opus-46-long",
      display_name: "Opus 4.6 Long",
      model: "claude:claude-opus-4-6",
      execution_mode: "sdk",
      context_window: "1m",
    }).expect(201);
    expect(opus46.body.agent.context_window).toBe("1m");
  });

  it("rejects 1M context for non-Opus and non-Claude agents", async () => {
    const { agent } = makeTestServer();
    const sonnet = await agent.post("/api/agents").send({
      name: "sonnet-long",
      display_name: "Sonnet Long",
      model: "claude:claude-sonnet-4-6",
      context_window: "1m",
    }).expect(400);
    expect(sonnet.body.error.code).toBe("invalid_context_window");

    const codex = await agent.post("/api/agents").send({
      name: "codex-long",
      display_name: "Codex Long",
      model: "codex:gpt-5.5",
      execution_mode: "cli",
      context_window: "1m",
    }).expect(400);
    expect(codex.body.error.code).toBe("invalid_context_window");
  });

  it("rejects PATCH when a model change would leave 1M context on an ineligible model", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({
      name: "opus-patch",
      display_name: "Opus Patch",
      model: "claude:claude-opus-4-7",
      context_window: "1m",
    }).expect(201);

    const rejected = await agent.patch("/api/agents/opus-patch").send({ model: "claude:claude-sonnet-4-6" }).expect(400);
    expect(rejected.body.error.code).toBe("invalid_context_window");

    const cleared = await agent.patch("/api/agents/opus-patch").send({
      model: "claude:claude-sonnet-4-6",
      context_window: "default",
    }).expect(200);
    expect(cleared.body.agent.model).toBe("claude:claude-sonnet-4-6");
    expect(cleared.body.agent.context_window).toBe("default");
  });

  it("rejects POST when execution_mode='cli' is paired with a non-codex pi model", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/agents").send({
      name: "bad-combo",
      display_name: "Bad",
      model: "pi:openai:gpt-4",
      execution_mode: "cli",
    }).expect(400);
    expect(res.body.error.code).toBe("incompatible_execution_mode");
    expect(res.body.error.execution_mode).toBe("cli");
    expect(res.body.error.model).toBe("pi:openai:gpt-4");
    expect(res.body.error.message).toMatch(/openai/);
  });

  it("accepts POST when execution_mode='cli' is paired with a codex model", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({
      name: "good-combo",
      display_name: "Good",
      model: "codex:gpt-5.5",
      execution_mode: "cli",
    }).expect(201);
  });

  it("rejects POST when execution_mode='cli' is paired with pi:openai-codex", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/agents").send({
      name: "bad-pi-codex-cli",
      display_name: "Bad Pi Codex CLI",
      model: "pi:openai-codex:gpt-5.5",
      execution_mode: "cli",
    }).expect(400);
    expect(res.body.error.code).toBe("incompatible_execution_mode");
    expect(res.body.error.message).toMatch(/openai-codex.*SDK/i);
  });

  it("rejects PATCH that would land an incompatible model+execution_mode pair", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({
      name: "patch-target",
      display_name: "Patch",
      model: "claude:claude-sonnet-4-6",
      execution_mode: "cli",
    }).expect(201);
    const res = await agent.patch("/api/agents/patch-target").send({ model: "pi:openai:gpt-4" }).expect(400);
    expect(res.body.error.code).toBe("incompatible_execution_mode");

    const res2 = await agent.post("/api/agents").send({
      name: "sdk-mover",
      display_name: "SDK Mover",
      model: "pi:openai:gpt-4",
      execution_mode: "sdk",
    }).expect(201);
    expect(res2.body.agent.execution_mode).toBe("sdk");
    const flip = await agent.patch("/api/agents/sdk-mover").send({ execution_mode: "cli" }).expect(400);
    expect(flip.body.error.code).toBe("incompatible_execution_mode");
  });

  it("POST /api/agents accepts explicit policy fields (budgets retired in v33)", async () => {
    const { agent, db } = makeTestServer();
    const res = await agent.post("/api/agents").send({
      name: "reviewer",
      display_name: "Reviewer",
      model: "claude:claude-sonnet-4-6",
      allow_self_review: false,
      browser_tools_review_only: true,
      subagent_mode: "workspace",
    }).expect(201);

    expect(res.body.agent.allow_self_review).toBe(false);
    expect(res.body.agent.browser_tools_review_only).toBe(true);
    expect(res.body.agent.subagent_mode).toBe("workspace");
    const row = db.prepare("SELECT allow_self_review, browser_tools_review_only, subagent_mode FROM agents WHERE name = ?").get("reviewer");
    expect(row).toEqual({ allow_self_review: 0, browser_tools_review_only: 1, subagent_mode: "workspace" });
  });

  it("POST /api/agents generates a unique slug from display_name when name is omitted", async () => {
    const { agent } = makeTestServer();
    const first = await agent.post("/api/agents").send({ display_name: "Code Reviewer", model: "claude:claude-sonnet-4-6" }).expect(201);
    const second = await agent.post("/api/agents").send({ display_name: "Code Reviewer", model: "claude:claude-sonnet-4-6" }).expect(201);

    expect(first.body.agent.name).toBe("code-reviewer");
    expect(second.body.agent.name).toBe("code-reviewer-2");
  });

  it("POST rejects missing fields", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "x" }).expect(400);
  });

  it("POST rejects legacy tier model aliases", async () => {
    const { agent } = makeTestServer();
    const bare = await agent.post("/api/agents").send({ name: "bare", display_name: "Bare", sdk: "claude", model: "sonnet" }).expect(400);
    expect(bare.body.error.code).toBe("invalid_model");

    const prefixed = await agent.post("/api/agents").send({ name: "prefixed", display_name: "Prefixed", sdk: "claude", model: "claude:sonnet" }).expect(400);
    expect(prefixed.body.error.code).toBe("invalid_model");
  });

  it("POST rejects invalid name (must be slug)", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "Has Spaces", display_name: "x", sdk: "claude", model: "claude:claude-sonnet-4-6" }).expect(400);
  });

  it("POST rejects duplicate name", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "dup", display_name: "X", sdk: "claude", model: "claude:claude-sonnet-4-6" });
    await agent.post("/api/agents").send({ name: "dup", display_name: "Y", sdk: "claude", model: "claude:claude-sonnet-4-6" }).expect(409);
  });

  it("GET /api/agents/:name returns single with parsed JSON allowlists", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });
    const res = await agent.get("/api/agents/coder").expect(200);
    expect(res.body.agent.skills_allowlist).toEqual([]);
    expect(res.body.agent.skills_allowlist_mode).toBe("all");
    expect(res.body.agent.mcp_allowlist).toEqual([]);
    expect(res.body.agent.mcp_allowlist_mode).toBe("all");
    expect(res.body.agent.builtin_allowlist).toEqual([]);
    expect(res.body.agent.builtin_allowlist_mode).toBe("all");
  });

  it("GET /api/agents/:name/memory returns current memory state", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-agent-memory-"));
    tempDirs.push(dataDir);
    const { agent, db } = makeTestServer({ dataDir });
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" }).expect(201);
    appendJournalEntry({
      dataDir,
      agent: "coder",
      runId: "run-1",
      taskId: "task-1",
      taskTitle: "Memory route",
      bullet: "Use the compact memory panel.",
    });
    writeMemory({ dataDir, agent: "coder", content: "# Facts\n- Memory panel is compact." });
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status)
      VALUES (?, NULL, 'consolidate', ?, ?, 'complete')
    `).run("run-1", "coder", 1234);
    db.prepare(`
      INSERT INTO agent_consolidations (agent_name, last_journal_hash, last_consolidated_at, last_run_id)
      VALUES (?, ?, ?, ?)
    `).run("coder", agentJournalHash({ dataDir, agent: "coder" }), 1234, "run-1");

    const res = await agent.get("/api/agents/coder/memory").expect(200);

    expect(res.body.memory).toMatchObject({
      agent: "coder",
      exists: true,
      journal_exists: true,
      journal_changed: false,
      freshness: "current",
      last_consolidated_at: 1234,
      last_run_id: "run-1",
    });
    expect(res.body.memory.content).toContain("Memory panel is compact.");
  });

  it("GET /api/agents/:name/memory reflects active consolidation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-agent-memory-active-"));
    tempDirs.push(dataDir);
    const consolidation = { runNow: vi.fn(), isActive: vi.fn(() => true) };
    const { agent } = makeTestServer({ dataDir, consolidation });
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" }).expect(201);
    appendJournalEntry({
      dataDir,
      agent: "coder",
      runId: "run-1",
      taskId: "task-1",
      taskTitle: "Memory route",
      bullet: "Consolidation is running.",
    });

    const res = await agent.get("/api/agents/coder/memory").expect(200);

    expect(consolidation.isActive).toHaveBeenCalledWith("coder");
    expect(res.body.memory).toMatchObject({
      freshness: "consolidating",
      journal_exists: true,
    });
  });

  it("GET /api/agents/:name/memory rejects missing agents", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-agent-memory-missing-"));
    tempDirs.push(dataDir);
    const { agent } = makeTestServer({ dataDir });
    await agent.get("/api/agents/missing/memory").expect(404);
  });

  it("PATCH updates fields including allowlists (arrays)", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });
    const res = await agent.patch("/api/agents/coder").send({ instructions: "new", skills_allowlist: ["example"] }).expect(200);
    expect(res.body.agent.instructions).toBe("new");
    expect(res.body.agent.skills_allowlist).toEqual(["example"]);
    expect(res.body.agent.skills_allowlist_mode).toBe("custom");
  });

  it("PATCH updates policy fields", async () => {
    const { agent, db } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });
    const res = await agent.patch("/api/agents/coder").send({
      allow_self_review: false,
      browser_tools_review_only: true,
      subagent_mode: "disabled",
    }).expect(200);

    expect(res.body.agent.allow_self_review).toBe(false);
    expect(res.body.agent.browser_tools_review_only).toBe(true);
    expect(res.body.agent.subagent_mode).toBe("disabled");
    const row = db.prepare("SELECT allow_self_review, browser_tools_review_only, subagent_mode FROM agents WHERE name = ?").get("coder");
    expect(row).toEqual({ allow_self_review: 0, browser_tools_review_only: 1, subagent_mode: "disabled" });
  });

  it("rejects invalid policy fields", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({
      name: "bad-bool",
      display_name: "Bad Bool",
      model: "claude:claude-sonnet-4-6",
      allow_self_review: "yes",
    }).expect(400);

    await agent.post("/api/agents").send({
      name: "bad-browser-bool",
      display_name: "Bad Browser Bool",
      model: "claude:claude-sonnet-4-6",
      browser_tools_review_only: "yes",
    }).expect(400);

    await agent.post("/api/agents").send({
      name: "bad-subagent-mode",
      display_name: "Bad Subagent Mode",
      model: "claude:claude-sonnet-4-6",
      subagent_mode: "always",
    }).expect(400);
  });

  it("PATCH preserves explicit empty custom allowlists", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });

    const res = await agent.patch("/api/agents/coder").send({
      skills_allowlist_mode: "custom",
      skills_allowlist: [],
      mcp_allowlist_mode: "custom",
      mcp_allowlist: [],
      builtin_allowlist_mode: "custom",
      builtin_allowlist: [],
    }).expect(200);

    expect(res.body.agent.skills_allowlist).toEqual([]);
    expect(res.body.agent.skills_allowlist_mode).toBe("custom");
    expect(res.body.agent.mcp_allowlist).toEqual([]);
    expect(res.body.agent.mcp_allowlist_mode).toBe("custom");
    expect(res.body.agent.builtin_allowlist).toEqual([]);
    expect(res.body.agent.builtin_allowlist_mode).toBe("custom");
  });

  it("PATCH derives sdk from explicit model refs and rejects tier aliases", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });

    const updated = await agent.patch("/api/agents/coder").send({ sdk: "claude", model: "pi:openai:gpt-5.5" }).expect(200);
    expect(updated.body.agent.sdk).toBe("pi");
    expect(updated.body.agent.model).toBe("pi:openai:gpt-5.5");

    const rejected = await agent.patch("/api/agents/coder").send({ model: "openai:opus" }).expect(400);
    expect(rejected.body.error.code).toBe("invalid_model");
  });

  it("accepts canonical runtime model references", async () => {
    const { agent } = makeTestServer();
    const claude = await agent.post("/api/agents").send({
      name: "claude-cli",
      display_name: "Claude CLI",
      model: "claude:claude-sonnet-4-6",
    }).expect(201);
    expect(claude.body.agent.sdk).toBe("claude");

    const codex = await agent.post("/api/agents").send({
      name: "codex-cli",
      display_name: "Codex CLI",
      model: "codex:gpt-5.5",
      execution_mode: "cli",
    }).expect(201);
    expect(codex.body.agent.sdk).toBe("codex");
  });

  it("canonicalizes legacy runtime model refs on create and patch while keeping codex first-class", async () => {
    const { agent } = makeTestServer();
    const created = await agent.post("/api/agents").send({
      name: "legacy-codex",
      display_name: "Legacy Codex",
      model: "codex:gpt-5.5",
      execution_mode: "cli",
    }).expect(201);
    expect(created.body.agent).toMatchObject({
      sdk: "codex",
      model: "codex:gpt-5.5",
    });

    const patched = await agent.patch("/api/agents/legacy-codex").send({
      model: "openai:gpt-5.5",
      execution_mode: "sdk",
    }).expect(200);
    expect(patched.body.agent).toMatchObject({
      sdk: "pi",
      model: "pi:openai:gpt-5.5",
      execution_mode: "sdk",
    });
  });

  it("normalizes stale max effort on create and patch", async () => {
    const { agent } = makeTestServer();
    const created = await agent.post("/api/agents").send({
      name: "openai-effort",
      display_name: "OpenAI Effort",
      model: "pi:openai:gpt-5.5",
      effort: "max",
    }).expect(201);
    expect(created.body.agent.effort).toBe("xhigh");

    const patched = await agent.patch("/api/agents/openai-effort").send({
      model: "claude:claude-sonnet-4-6",
    }).expect(200);
    expect(patched.body.agent.effort).toBe("high");

    const opus = await agent.post("/api/agents").send({
      name: "opus-effort",
      display_name: "Opus Effort",
      model: "claude:claude-opus-4-7",
      effort: "max",
    }).expect(201);
    expect(opus.body.agent.effort).toBe("max");
  });

  it("POST rejects unavailable built-in providers", async () => {
    delete process.env.OPENAI_API_KEY;
    const { agent } = makeTestServer();
    const res = await agent.post("/api/agents").send({
      name: "openai-missing",
      display_name: "OpenAI Missing",
      model: "pi:openai:gpt-5.5",
    }).expect(400);
    expect(res.body.error.code).toBe("invalid_model");
    expect(res.body.error.message).toMatch(/OPENAI_API_KEY/);
  });

  it("POST rejects disabled skills and unavailable MCP allowlist entries", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-agent-availability-"));
    tempDirs.push(dataDir);
    mkdirSync(join(dataDir, "skills", "off"), { recursive: true });
    writeFileSync(join(dataDir, "skills", "off", "SKILL.md"), "---\nname: off\nenabled: false\ntrigger: off\n---\nbody");
    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(join(dataDir, "config", "mcp.json"), JSON.stringify({
      mcpServers: { missing: { command: "/definitely/not/worklab-mcp" } },
    }));

    const { agent } = makeTestServer({ dataDir });
    const disabledSkill = await agent.post("/api/agents").send({
      name: "skill-test",
      display_name: "Skill Test",
      model: "claude:claude-sonnet-4-6",
      skills_allowlist: ["off"],
    }).expect(400);
    expect(disabledSkill.body.error.code).toBe("unavailable_selection");

    const missingMcp = await agent.post("/api/agents").send({
      name: "mcp-test",
      display_name: "MCP Test",
      model: "claude:claude-sonnet-4-6",
      mcp_allowlist: ["missing"],
    }).expect(400);
    expect(missingMcp.body.error.code).toBe("unavailable_selection");
  });

  it("POST rejects known non-runnable custom models", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-agent-model-"));
    try {
      const { agent, db } = makeTestServer({ dataDir });
      const provider = createProvider({
        db,
        dataDir,
        name: "ollama",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
      });
      upsertModel({
        db,
        providerId: provider.id,
        modelName: "nomic-embed-text:v1.5",
        displayName: "nomic-embed-text:v1.5",
        capabilities: { advertised_capabilities: ["embedding"], embedding: true, chat: false },
        enabled: true,
      });

      const res = await agent.post("/api/agents").send({
        name: "embedder",
        display_name: "Embedder",
        model: `pi:${provider.id}:nomic-embed-text:v1.5`,
      }).expect(400);
      expect(res.body.error.code).toBe("invalid_model");
      expect(res.body.error.message).toMatch(/not runnable for agents/i);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("DELETE removes agent", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });
    await agent.delete("/api/agents/coder").expect(204);
    await agent.get("/api/agents/coder").expect(404);
  });

  it("POST /api/agents/:name/consolidate delegates to consolidation manager", async () => {
    const consolidation = { runNow: vi.fn(() => ({ runId: "run_123" })) };
    const { agent } = makeTestServer({ consolidation });
    const res = await agent.post("/api/agents/coder/consolidate").expect(200);
    expect(consolidation.runNow).toHaveBeenCalledWith("coder", { force: true });
    expect(res.body).toEqual({ runId: "run_123" });
  });
});
