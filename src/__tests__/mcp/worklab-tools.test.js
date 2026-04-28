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

  it("run_log_read returns raw JSONL when the raw output file is available", async () => {
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

    const result = await createToolHandlers(c).run_log_read({ run_id: "run-raw" });

    expect(result.source).toBe("raw_output_path");
    expect(result.content).toContain("\"type\":\"started\"");
    expect(result.run).toMatchObject({ id: "run-raw", task_id: "t1", mode: "execute" });
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

    const result = await createToolHandlers(c).run_log_read({ run_id: "run-events" });

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
});
