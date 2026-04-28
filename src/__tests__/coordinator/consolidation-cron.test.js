import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/test-db.js";
import { createConsolidationManager } from "../../coordinator/consolidation-cron.js";
import { writeSettings } from "../../core/settings.js";
import { writeMemory } from "../../core/journal.js";
import { buildTaskRunInput } from "../../core/run-input.js";

describe("consolidation manager", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function fixture({ onComplete } = {}) {
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
        onComplete?.({ dataDir, runId });
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
      config: { timezone: "UTC" },
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

  it("passes persisted worker timeout and cancel grace to consolidation runs", () => {
    const { db, spawn, manager } = fixture();
    writeSettings(db, { worker_timeout_ms: 3456, cancel_grace_ms: 67 });
    manager.runNow("alice");

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      runTimeoutMs: 3456,
      cancelGraceMs: 67,
    }));
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

  it("makes consolidated memory available to the next task run prompt", async () => {
    const { dataDir, db, spawn, manager } = fixture({
      onComplete: () => {
        writeMemory({
          dataDir,
          agent: "alice",
          content: "# Facts\n- Rollback checklist lives in MEMORY.md.",
        });
      },
    });
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks
        (id, task_key, root_task_id, title, instructions, stage, owner_agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("task-1", "T-1", "task-1", "Use memory", "Use stored facts.", "execute", "alice", now, now);

    const result = manager.runNow("alice");
    await spawn.mock.results[0].value.done;
    await Promise.resolve();

    const consolidation = db.prepare("SELECT last_run_id FROM agent_consolidations WHERE agent_name = ?").get("alice");
    expect(consolidation.last_run_id).toBe(result.runId);

    const input = buildTaskRunInput({
      db,
      config: { dataDir, repoRoot: dataDir, workspace: dataDir },
      taskId: "task-1",
      agentName: "alice",
      runId: "run-next",
      mode: "execute",
    });

    expect(input.memory).toContain("Rollback checklist lives in MEMORY.md.");
    expect(input.systemPrompt).toContain("## Memory");
    expect(input.systemPrompt).toContain("Rollback checklist lives in MEMORY.md.");
  });
});
