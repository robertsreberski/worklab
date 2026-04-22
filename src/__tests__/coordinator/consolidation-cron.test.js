import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/test-db.js";
import { createConsolidationManager } from "../../coordinator/consolidation-cron.js";

describe("consolidation manager", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function fixture() {
    const dataDir = join(mkdtemp(), "data");
    mkdirSync(join(dataDir, "agents", "alice"), { recursive: true });
    writeFileSync(join(dataDir, "agents", "alice", "JOURNAL.md"), "## first\n- remember the rollback checklist\n");

    const db = makeTestDb();
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("alice", "Alice", "claude", "claude:claude-sonnet-4-6", now, now);

    const broadcasts = [];
    const broker = { broadcast: vi.fn((channel, event) => broadcasts.push({ channel, event })) };
    const spawn = vi.fn(({ db: workerDb, runId }) => {
      const done = Promise.resolve().then(() => {
        workerDb.prepare("UPDATE task_runs SET status = 'complete', ended_at = ?, exit_code = 0 WHERE id = ?")
          .run(Date.now(), runId);
        return { status: "complete" };
      });
      return { pid: 123, cancel: vi.fn(), done };
    });
    const manager = createConsolidationManager({
      db,
      broker,
      spawn,
      workerBinary: "worker.js",
      dataDir,
      repoRoot: dataDir,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    return { dataDir, db, broker, broadcasts, spawn, manager };
  }

  function mkdtemp() {
    const dir = join(tmpdir(), `worklab-consolidation-${Math.random().toString(36).slice(2)}-`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  it("starts a taskless consolidation run and records the journal hash", async () => {
    const { db, broadcasts, spawn, manager } = fixture();
    const result = manager.runNow("alice");
    expect(result.runId).toBeTruthy();
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      args: ["--mode", "consolidate", "--agent", "alice"],
      taskId: null,
      runId: result.runId,
    }));

    await spawn.mock.results[0].value.done;
    await Promise.resolve();

    const run = db.prepare("SELECT task_id, mode, agent_name, status FROM task_runs WHERE id = ?").get(result.runId);
    expect(run).toMatchObject({
      task_id: null,
      mode: "consolidate",
      agent_name: "alice",
      status: "complete",
    });

    const consolidation = db.prepare("SELECT last_journal_hash, last_run_id FROM agent_consolidations WHERE agent_name = ?").get("alice");
    expect(consolidation.last_journal_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(consolidation.last_run_id).toBe(result.runId);
    expect(broadcasts.map((b) => b.event.type)).toEqual(expect.arrayContaining([
      "run_started",
      "run_ended",
      "agent_consolidated",
    ]));
  });

  it("scheduled ticks run at the configured hour and skip unchanged journals", async () => {
    const { db, spawn, manager } = fixture();
    const first = manager.tick(new Date("2026-04-22T03:10:00Z"));
    expect(first.started.length).toBe(1);

    await spawn.mock.results[0].value.done;
    await Promise.resolve();

    const sameDay = manager.tick(new Date("2026-04-22T03:20:00Z"));
    expect(sameDay).toMatchObject({ skipped: true, reason: "already checked today" });

    const nextDay = manager.tick(new Date("2026-04-23T03:10:00Z"));
    expect(nextDay.started).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_runs").get().count).toBe(1);
  });
});
