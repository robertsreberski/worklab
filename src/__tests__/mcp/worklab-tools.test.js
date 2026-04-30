import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, runMigrations } from "../../core/db.js";
import { createToolHandlers } from "../../mcp/worklab-tools.js";

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
      model: "codex:gpt-5.5",
      effort: "high",
      description: "Reviews implementation work.",
      instructions: "Review changes and report concrete risks.",
      builtin_allowlist_mode: "custom",
      builtin_allowlist: ["Read", "Grep"],
    });

    expect(result.agent).toMatchObject({
      name: "review-specialist",
      display_name: "Review Specialist",
      model: "codex:gpt-5.5",
      sdk: "codex",
      effort: "high",
      enabled: true,
      builtin_allowlist_mode: "custom",
    });
    seedDb(c.dataDir, (db) => {
      const row = db.prepare("SELECT instructions, builtin_allowlist FROM agents WHERE name = 'review-specialist'").get();
      expect(row.instructions).toContain("Review changes");
      expect(JSON.parse(row.builtin_allowlist)).toEqual(["Read", "Grep"]);
    });
  });
});
