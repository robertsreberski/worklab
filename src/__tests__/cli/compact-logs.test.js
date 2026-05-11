import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactLogs } from "../../cli/compact-logs.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import { kbCreate } from "../../core/kb.js";

function createDataDir() {
  return mkdtempSync(join(tmpdir(), "worklab-compact-logs-"));
}

function seedDb(dataDir) {
  const db = openDb(join(dataDir, "worklab.db"));
  runMigrations(db);
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  db.prepare(`
    INSERT INTO tasks (id, task_key, root_task_id, title, instructions, stage, run_policy, created_at, updated_at)
    VALUES ('task-1', 'T-1', 'task-1', 'Compact logs', '', 'done', 'manual', ?, ?)
  `).run(old, old);
  const insertRun = db.prepare(`
    INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status)
    VALUES (?, 'task-1', 'execute', 'execute', 'alpha', ?, ?, ?, ?)
  `);
  insertRun.run("run-apply", old, old + 1, "complete", "succeeded");
  insertRun.run("run-running", old, null, "running", "running");
  insertRun.run("run-pinned", old, old + 1, "complete", "succeeded");
  const insertLog = db.prepare(`
    INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
    VALUES (?, ?, ?, 'complete', ?)
  `);
  const events = (prefix) => [
    { type: "message", text: `${prefix} old ${"x".repeat(1000)}` },
    { type: "message", text: `${prefix} keep ${"y".repeat(1000)}` },
  ];
  insertLog.run("log-apply", "run-apply", JSON.stringify(events("apply")), old);
  insertLog.run("log-running", "run-running", JSON.stringify(events("running")), old);
  insertLog.run("log-pinned", "run-pinned", JSON.stringify(events("pinned")), old);
  db.close();
}

function readEvents(dataDir, runId) {
  const db = openDb(join(dataDir, "worklab.db"));
  const row = db.prepare(`
    SELECT events, events_compacted_at, events_original_count, events_original_bytes,
           events_compaction_strategy, events_compaction_version, events_compacted_bytes
    FROM agent_logs WHERE task_run_id = ?
  `).get(runId);
  db.close();
  return { ...row, events: JSON.parse(row.events) };
}

describe("compact logs CLI helpers", () => {
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("dry-runs by default without changing event blobs", () => {
    const dataDir = createDataDir();
    dirs.push(dataDir);
    seedDb(dataDir);
    kbCreate({
      dataDir,
      slug: "pinned-run-result",
      title: "Pinned result",
      body: "",
      category: "run-results",
      tags: ["run-result"],
      source_run_id: "run-pinned",
      pinned: true,
      author: "test",
    });
    const before = readEvents(dataDir, "run-apply");

    const report = compactLogs({ dataDir, minAgeDays: 0, minBytes: 1, keepEvents: 1 });
    const after = readEvents(dataDir, "run-apply");

    expect(report.dry_run).toBe(true);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({ task_run_id: "run-apply", action: "compact" });
    expect(report.estimated_reclaimable_bytes).toBeGreaterThan(0);
    expect(report.strategy).toBe("slim-db");
    expect(report.event_blob_bytes_after).toBeLessThan(report.event_blob_bytes_before);
    expect(after.events).toEqual(before.events);
    expect(after.events_compacted_at).toBeNull();
  });

  it("applies compaction only to eligible non-running and non-pinned logs", () => {
    const dataDir = createDataDir();
    dirs.push(dataDir);
    seedDb(dataDir);
    kbCreate({
      dataDir,
      slug: "pinned-run-result",
      title: "Pinned result",
      body: "",
      category: "run-results",
      tags: ["run-result"],
      source_run_id: "run-pinned",
      pinned: true,
      author: "test",
    });

    const report = compactLogs({ dataDir, apply: true, minAgeDays: 0, minBytes: 1, keepEvents: 1 });
    const compacted = readEvents(dataDir, "run-apply");
    const running = readEvents(dataDir, "run-running");
    const pinned = readEvents(dataDir, "run-pinned");

    expect(report.dry_run).toBe(false);
    expect(report.compacted_count).toBe(1);
    expect(compacted.events).toHaveLength(1);
    expect(compacted.events[0].text).toContain("apply keep");
    expect(compacted.events_original_count).toBe(2);
    expect(compacted.events_original_bytes).toBeGreaterThan(0);
    expect(compacted.events_compacted_at).toBeGreaterThan(0);
    expect(compacted.events_compaction_strategy).toBe("slim-db");
    expect(compacted.events_compaction_version).toBe(2);
    expect(compacted.events_compacted_bytes).toBeGreaterThan(0);
    expect(running.events).toHaveLength(2);
    expect(pinned.events).toHaveLength(2);
  });

  it("recompacts already compacted logs with slim tool payload storage", () => {
    const dataDir = createDataDir();
    dirs.push(dataDir);
    const db = openDb(join(dataDir, "worklab.db"));
    runMigrations(db);
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    db.prepare(`
      INSERT INTO tasks (id, task_key, root_task_id, title, instructions, stage, run_policy, created_at, updated_at)
      VALUES ('task-2', 'T-2', 'task-2', 'Compact logs', '', 'done', 'manual', ?, ?)
    `).run(old, old);
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status, raw_output_path)
      VALUES ('run-recompact', 'task-2', 'execute', 'execute', 'alpha', ?, ?, 'complete', 'succeeded', ?)
    `).run(old, old + 1, join(dataDir, "logs", "runs", "run-recompact.jsonl"));
    db.prepare(`
      INSERT INTO agent_logs (id, task_run_id, events, status, created_at, events_compacted_at, events_original_count, events_original_bytes)
      VALUES ('log-recompact', 'run-recompact', ?, 'complete', ?, ?, 2, ?)
    `).run(JSON.stringify([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "a.js", content: "x".repeat(20_000) } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "y".repeat(20_000), is_error: false }] } },
    ]), old, old, 50_000);
    db.close();

    const skipped = compactLogs({ dataDir, apply: true, minAgeDays: 0, minBytes: 1 });
    const report = compactLogs({ dataDir, apply: true, recompact: true, minAgeDays: 0, minBytes: 1 });
    const compacted = readEvents(dataDir, "run-recompact");

    expect(skipped.compacted_count).toBe(0);
    expect(report.compacted_count).toBe(1);
    expect(report.candidates[0]).toMatchObject({ already_compacted: true, has_raw_log: true });
    expect(compacted.events[0].message.content[0].input).toBeUndefined();
    expect(compacted.events[0].message.content[0].input_omitted).toBe(true);
    expect(compacted.events[1].message.content[0].content).toBeUndefined();
    expect(compacted.events[1].message.content[0].content_omitted).toBe(true);
  });

  it("refuses --apply while a coordinator pid is active", () => {
    const dataDir = createDataDir();
    dirs.push(dataDir);
    seedDb(dataDir);
    writeFileSync(join(dataDir, ".coordinator.pid"), String(process.pid));

    expect(() => compactLogs({ dataDir, apply: true, minAgeDays: 0, minBytes: 1 })).toThrow(/coordinator is running/i);
    expect(existsSync(join(dataDir, ".coordinator.pid"))).toBe(true);
    expect(readFileSync(join(dataDir, ".coordinator.pid"), "utf8")).toBe(String(process.pid));
  });
});
