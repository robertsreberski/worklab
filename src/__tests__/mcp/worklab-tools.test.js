import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import { createProvider, upsertModel } from "../../core/providers.js";
import { recordAgentMemoryCandidates } from "../../core/agent-learning.js";
import { createToolHandlers } from "../../mcp/agent/tools/index.js";

describe("worklab-tools handlers", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function ctx() {
    const d = mkdtempSync(join(tmpdir(), "worklab-tools-")); dirs.push(d);
    return { dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "demo" };
  }

  function seedDb(dataDir, fn) {
    const db = openDb(join(dataDir, "worklab.db"));
    runMigrations(db);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  it("journal_append writes a bullet to the correct file", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    const r = await h.journal_append({ bullet: "hello world" });
    expect(r.ok).toBe(true);
    const content = readFileSync(join(c.dataDir, "agents/a/JOURNAL.md"), "utf8");
    expect(content).toMatch(/- hello world/);
  });

  it("journal_append rejects empty bullet", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await expect(h.journal_append({ bullet: "" })).rejects.toThrow();
  });

  it("journal_summary appends (summary) entry", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.journal_append({ bullet: "b" });
    await h.journal_summary({ text: "done" });
    const content = readFileSync(join(c.dataDir, "agents/a/JOURNAL.md"), "utf8");
    expect(content).toMatch(/\(summary\)/);
  });

  it("memory_read returns empty string when no memory file", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    const r = await h.memory_read({});
    expect(r.content).toBe("");
  });

  it("memory_read returns existing memory content", async () => {
    const c = ctx();
    mkdirSync(join(c.dataDir, "agents/a"), { recursive: true });
    writeFileSync(join(c.dataDir, "agents/a/MEMORY.md"), "# memory\nstuff");
    const h = createToolHandlers(c);
    const r = await h.memory_read({});
    expect(r.content).toBe("# memory\nstuff");
  });

  it("memory_search includes structured learning memories", async () => {
    const c = ctx();
    seedDb(c.dataDir, (db) => {
      db.prepare(`
        INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at)
        VALUES ('a', 'A', 'claude', 'claude:claude-sonnet-4-6', 1, 1)
      `).run();
      recordAgentMemoryCandidates(db, {
        agentName: "a",
        autoApproveThreshold: 0.5,
        candidates: [{ kind: "procedure", content: "Run focused memory tests before full verification.", confidence: 0.9 }],
      });
    });
    const h = createToolHandlers(c);
    const r = await h.memory_search({ query: "focused memory tests" });
    expect(r.results.some((result) => result.kind === "agent_memory" && result.snippet.includes("focused memory tests"))).toBe(true);
  });

  it("todo_write replaces the current run checklist and todo_read returns it", async () => {
    const c = ctx();
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'demo', 1, 1)").run();
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status)
        VALUES ('r1', 't1', 'execute', 'execute', 'a', 1, 'running', 'running')
      `).run();
    });
    const handlers = createToolHandlers(c);

    const written = await handlers.todo_write({
      todos: [
        { content: "Inspect the run pipeline", status: "completed" },
        { content: "Add the MCP tool", status: "in_progress", active_form: "Wiring handlers" },
        { content: "Expose live UI", status: "pending" },
      ],
    });
    const read = await handlers.todo_read({});

    expect(written.ok).toBe(true);
    expect(written.todo_state).toMatchObject({
      total: 3,
      completed: 1,
      update_count: 1,
      todos: [
        { content: "Inspect the run pipeline", status: "completed" },
        { content: "Add the MCP tool", status: "in_progress", active_form: "Wiring handlers" },
        { content: "Expose live UI", status: "pending" },
      ],
    });
    expect(read.todo_state).toEqual(written.todo_state);

    seedDb(c.dataDir, (db) => {
      const row = db.prepare("SELECT todo_state_json FROM task_runs WHERE id = 'r1'").get();
      const stored = JSON.parse(row.todo_state_json);
      expect(stored.todos).toHaveLength(3);
      expect(stored.update_count).toBe(1);
    });
  });

  it("todo_write preserves newlines in multi-line content", async () => {
    const c = ctx();
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'demo', 1, 1)").run();
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status)
        VALUES ('r1', 't1', 'execute', 'execute', 'a', 1, 'running', 'running')
      `).run();
    });

    const handlers = createToolHandlers(c);
    const written = await handlers.todo_write({
      todos: [
        {
          content: "Update X.\nNote: keep Y aligned with   Z",
          status: "in_progress",
          active_form: "Updating X\nthen Y",
        },
      ],
    });

    expect(written.todo_state.todos[0].content).toBe("Update X.\nNote: keep Y aligned with Z");
    expect(written.todo_state.todos[0].active_form).toBe("Updating X\nthen Y");
  });

  it("todo_write rejects ambiguous active work", async () => {
    const c = ctx();
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'demo', 1, 1)").run();
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status)
        VALUES ('r1', 't1', 'execute', 'execute', 'a', 1, 'running', 'running')
      `).run();
    });

    const result = await createToolHandlers(c).todo_write({
      todos: [
        { content: "One", status: "in_progress" },
        { content: "Two", status: "in_progress" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("invalid_input");
    expect(result.error.message).toMatch(/one in_progress/);
  });

  it("todo_write returns invalid_input for zod schema violations without persisting", async () => {
    const c = ctx();
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'demo', 1, 1)").run();
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status)
        VALUES ('r1', 't1', 'execute', 'execute', 'a', 1, 'running', 'running')
      `).run();
    });

    const result = await createToolHandlers(c).todo_write({
      todos: [{ content: "", status: "pending" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("invalid_input");

    seedDb(c.dataDir, (db) => {
      const row = db.prepare("SELECT todo_state_json FROM task_runs WHERE id = 'r1'").get();
      const stored = JSON.parse(row.todo_state_json);
      expect(stored.todos).toEqual([]);
      expect(stored.update_count).toBe(0);
    });
  });

  it("run_log_read returns raw JSONL when tail mode is requested", async () => {
    const c = ctx();
    const rawDir = join(c.dataDir, "logs", "runs");
    const rawPath = join(rawDir, "run-raw.jsonl");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(rawPath, "{\"type\":\"started\"}\n{\"type\":\"final\",\"text\":\"ok\"}\n");
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'demo', 1, 1)").run();
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status, raw_output_path)
        VALUES ('run-raw', 't1', 'execute', 'execute', 'a', 1, 'complete', 'succeeded', ?)
      `).run(rawPath);
    });

    const result = await createToolHandlers(c).run_log_read({ run_id: "run-raw", mode: "tail" });

    expect(result.source).toBe("raw_output_path");
    expect(result.mode).toBe("tail");
    expect(result.content).toContain("\"type\":\"started\"");
    expect(result.run).toMatchObject({ id: "run-raw", task_id: "t1", mode: "execute" });
  });

  it("run_log_read returns a compact summary by default", async () => {
    const c = ctx();
    const rawDir = join(c.dataDir, "logs", "runs");
    const rawPath = join(rawDir, "run-summary.jsonl");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(rawPath, [
      JSON.stringify({
        type: "sdk_event",
        event: { type: "assistant", message: { content: [{ type: "tool_use", id: "glob-1", name: "Glob", input: { pattern: "**/*" } }] } },
      }),
      JSON.stringify({
        type: "sdk_event",
        event: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "glob-1", content: "a\nb\nc", is_error: false }] } },
      }),
      JSON.stringify({ type: "runtime_warning", warning_kind: "context_bloat", message: "large output" }),
    ].join("\n") + "\n");
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'demo', 1, 1)").run();
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status, raw_output_path)
        VALUES ('run-summary', 't1', 'execute', 'execute', 'a', 1, 'complete', 'succeeded', ?)
      `).run(rawPath);
    });

    const result = await createToolHandlers(c).run_log_read({ run_id: "run-summary" });

    expect(result.mode).toBe("summary");
    expect(result.content_type).toBe("application/json");
    expect(result.summary.tool_calls).toContainEqual({ name: "Glob", count: 1 });
    expect(result.summary.largest_tool_results[0]).toMatchObject({ tool: "Glob" });
    expect(result.summary.warnings[0]).toMatchObject({ kind: "context_bloat" });
  });

  it("run_log_read tails large raw logs on request and can return full content explicitly", async () => {
    const c = ctx();
    const rawDir = join(c.dataDir, "logs", "runs");
    const rawPath = join(rawDir, "run-large.jsonl");
    mkdirSync(rawDir, { recursive: true });
    const content = Array.from({ length: 200 }, (_, index) => JSON.stringify({ type: "event", index, text: "x".repeat(30) })).join("\n");
    writeFileSync(rawPath, `${content}\n`);
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'demo', 1, 1)").run();
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status, raw_output_path)
        VALUES ('run-large', 't1', 'execute', 'execute', 'a', 1, 'complete', 'succeeded', ?)
      `).run(rawPath);
    });
    const handlers = createToolHandlers(c);

    const tail = await handlers.run_log_read({ run_id: "run-large", mode: "tail", limit_bytes: 1000 });
    const full = await handlers.run_log_read({ run_id: "run-large", mode: "full" });

    expect(tail.truncated).toBe(true);
    expect(tail.offset_bytes).toBeGreaterThan(0);
    expect(Buffer.byteLength(tail.content)).toBeLessThanOrEqual(1000);
    expect(full.truncated).toBe(false);
    expect(full.content).toContain("\"index\":0");
  });

  it("run_log_read falls back to stored agent log events", async () => {
    const c = ctx();
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'demo', 1, 1)").run();
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status)
        VALUES ('run-events', 't1', 'execute', 'execute', 'a', 1, 'complete', 'succeeded')
      `).run();
      db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES ('log1', 'run-events', ?, 'complete', 1)")
        .run(JSON.stringify([{ type: "started" }, { type: "final", text: "ok" }]));
    });

    const result = await createToolHandlers(c).run_log_read({ run_id: "run-events", mode: "tail" });

    expect(result.source).toBe("agent_logs.events");
    expect(result.event_count).toBe(2);
    expect(result.content).toBe("{\"type\":\"started\"}\n{\"type\":\"final\",\"text\":\"ok\"}\n");
  });

  it("run_log_read rejects missing runs and raw paths outside the data dir", async () => {
    const c = ctx();
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'demo', 1, 1)").run();
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status, raw_output_path)
        VALUES ('run-outside', 't1', 'execute', 'execute', 'a', 1, 'complete', 'succeeded', '/tmp/outside.jsonl')
      `).run();
    });
    const handlers = createToolHandlers(c);

    await expect(handlers.run_log_read({ run_id: "missing" })).rejects.toThrow("run not found");
    await expect(handlers.run_log_read({ run_id: "run-outside" })).rejects.toThrow("outside data dir");
  });

  it("list_children returns subtasks linked via task_edges", async () => {
    const c = ctx();
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, stage, created_at, updated_at) VALUES ('t1', 'parent', 'awaiting_children', 1, 1)").run();
      db.prepare("INSERT INTO tasks (id, title, stage, parent_task_id, subtask_order, created_at, updated_at) VALUES ('c1', 'child a', 'execute', 't1', 0, 2, 2)").run();
      db.prepare("INSERT INTO tasks (id, title, stage, parent_task_id, subtask_order, created_at, updated_at) VALUES ('c2', 'child b', 'done', 't1', 1, 3, 3)").run();
      db.prepare("INSERT INTO task_edges (parent_task_id, child_task_id, edge_type, required, created_at) VALUES ('t1', 'c1', 'subtask', 1, 1)").run();
      db.prepare("INSERT INTO task_edges (parent_task_id, child_task_id, edge_type, required, created_at) VALUES ('t1', 'c2', 'subtask', 0, 1)").run();
    });
    const result = await createToolHandlers(c).list_children({});
    expect(result.parent_task_id).toBe("t1");
    expect(result.children.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(result.children[0]).toMatchObject({ title: "child a", required: true, stage: "execute" });
    expect(result.children[1]).toMatchObject({ required: false, stage: "done" });
  });

  it("get_child_result returns the latest run result for a subtask", async () => {
    const c = ctx();
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, stage, created_at, updated_at) VALUES ('t1', 'parent', 'awaiting_children', 1, 1)").run();
      db.prepare("INSERT INTO tasks (id, title, stage, parent_task_id, created_at, updated_at) VALUES ('c1', 'child', 'done', 't1', 2, 2)").run();
      db.prepare("INSERT INTO task_edges (parent_task_id, child_task_id, edge_type, required, created_at) VALUES ('t1', 'c1', 'subtask', 1, 1)").run();
      db.prepare(`
        INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status, decision, summary, result_json)
        VALUES ('run-c1', 'c1', 'execute', 'execute', 'a', 1, 2, 'complete', 'succeeded', 'advance', 'all done', ?)
      `).run(JSON.stringify({ schema: "worklab.v2", decision: "advance", summary: "all done" }));
    });
    const result = await createToolHandlers(c).get_child_result({ child_task_id: "c1" });
    expect(result.title).toBe("child");
    expect(result.last_run.decision).toBe("advance");
    expect(result.last_run.result.summary).toBe("all done");
  });

  it("get_child_result rejects tasks that aren't children of the calling task", async () => {
    const c = ctx();
    seedDb(c.dataDir, (db) => {
      db.prepare("INSERT INTO tasks (id, title, stage, created_at, updated_at) VALUES ('t1', 'parent', 'execute', 1, 1)").run();
      db.prepare("INSERT INTO tasks (id, title, stage, created_at, updated_at) VALUES ('rogue', 'unrelated', 'execute', 2, 2)").run();
    });
    await expect(createToolHandlers(c).get_child_result({ child_task_id: "rogue" })).rejects.toThrow(/forbidden/);
  });

  it("agent_create creates a runnable Worklab agent", async () => {
    const c = ctx();
    seedDb(c.dataDir, () => {});

    const result = await createToolHandlers(c).agent_create({
      display_name: "Review Specialist",
      model: "pi:openai-codex:gpt-5.5",
      effort: "high",
      description: "Reviews implementation work.",
      instructions: "Review changes and report concrete risks.",
      builtin_allowlist_mode: "custom",
      builtin_allowlist: ["Read", "Grep"],
      browser_tools_review_only: true,
    });

    expect(result.agent).toMatchObject({
      name: "review-specialist",
      display_name: "Review Specialist",
      model: "pi:openai-codex:gpt-5.5",
      sdk: "pi",
      effort: "high",
      enabled: true,
      builtin_allowlist_mode: "custom",
      browser_tools_review_only: true,
    });
    seedDb(c.dataDir, (db) => {
      const row = db.prepare("SELECT instructions, builtin_allowlist, browser_tools_review_only FROM agents WHERE name = 'review-specialist'").get();
      expect(row.instructions).toContain("Review changes");
      expect(JSON.parse(row.builtin_allowlist)).toEqual(["Read", "Grep"]);
      expect(row.browser_tools_review_only).toBe(1);
    });
  });

  it("agent_create creates Codex CLI agents with explicit execution mode", async () => {
    const c = ctx();
    seedDb(c.dataDir, () => {});

    const result = await createToolHandlers(c).agent_create({
      display_name: "Legacy Codex Specialist",
      model: "codex:gpt-5.5",
      execution_mode: "cli",
    });

    expect(result.agent).toMatchObject({
      name: "legacy-codex-specialist",
      model: "codex:gpt-5.5",
      sdk: "codex",
      execution_mode: "cli",
    });
  });

  it("agent_create accepts runnable custom Pi provider models", async () => {
    const c = ctx();
    let providerId;
    seedDb(c.dataDir, (db) => {
      const provider = createProvider({
        db,
        dataDir: c.dataDir,
        name: "local",
        provider_type: "openai_compat",
        base_url: "http://localhost:8000",
      });
      providerId = provider.id;
      upsertModel({
        db,
        providerId,
        modelName: "gemma3:4b",
        displayName: "gemma3:4b",
        enabled: true,
      });
    });

    const result = await createToolHandlers(c).agent_create({
      display_name: "Local Model Specialist",
      model: `pi:${providerId}:gemma3:4b`,
    });

    expect(result.agent).toMatchObject({
      name: "local-model-specialist",
      model: `pi:${providerId}:gemma3:4b`,
      sdk: "pi",
    });
  });
});
