import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { createProvider, upsertModel } from "../../core/providers.js";

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

  it("POST /api/agents creates with required fields", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" }).expect(201);
    expect(res.body.agent.name).toBe("coder");
    expect(res.body.agent.enabled).toBe(true);
    expect(res.body.agent.effort).toBe("medium");
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
    expect(res.body.agent.mcp_allowlist).toEqual([]);
    expect(res.body.agent.builtin_allowlist).toEqual([]);
  });

  it("PATCH updates fields including allowlists (arrays)", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });
    const res = await agent.patch("/api/agents/coder").send({ instructions: "new", skills_allowlist: ["example"] }).expect(200);
    expect(res.body.agent.instructions).toBe("new");
    expect(res.body.agent.skills_allowlist).toEqual(["example"]);
  });

  it("PATCH derives sdk from explicit model refs and rejects tier aliases", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });

    const updated = await agent.patch("/api/agents/coder").send({ sdk: "claude", model: "openai:gpt-5.4-mini" }).expect(200);
    expect(updated.body.agent.sdk).toBe("openai");
    expect(updated.body.agent.model).toBe("openai:gpt-5.4-mini");

    const rejected = await agent.patch("/api/agents/coder").send({ model: "openai:opus" }).expect(400);
    expect(rejected.body.error.code).toBe("invalid_model");
  });

  it("accepts local CLI model references", async () => {
    const { agent } = makeTestServer();
    const claude = await agent.post("/api/agents").send({
      name: "claude-cli",
      display_name: "Claude CLI",
      model: "claude-code:claude-sonnet-4-6",
    }).expect(201);
    expect(claude.body.agent.sdk).toBe("claude-code");

    const codex = await agent.post("/api/agents").send({
      name: "codex-cli",
      display_name: "Codex CLI",
      model: "codex:gpt-5.4",
    }).expect(201);
    expect(codex.body.agent.sdk).toBe("codex");
  });

  it("POST rejects unavailable built-in providers", async () => {
    delete process.env.OPENAI_API_KEY;
    const { agent } = makeTestServer();
    const res = await agent.post("/api/agents").send({
      name: "openai-missing",
      display_name: "OpenAI Missing",
      model: "openai:gpt-5.4",
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
        model: `vercel:${provider.id}:nomic-embed-text:v1.5`,
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
