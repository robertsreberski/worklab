import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/test-db.js";
import { createTaskWatcher } from "../../coordinator/task-watcher.js";
import { newRunId, newTaskId } from "../../core/ids.js";

function stubBroker() {
  const broadcasts = [];
  return {
    broadcasts,
    subscribe: () => {},
    unsubscribe: () => {},
    broadcast: (c, p) => broadcasts.push({ c, p }),
    size: () => 0,
  };
}

function seedAgent(db, name = "coder") {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(name, name, "claude", "claude:claude-sonnet-4-6", now, now);
}

function seedTask(db, { owner = "coder", stage = "execute" } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks
      (id, root_task_id, project_id, title, stage, owner_agent, planner_agent, reviewer_agent, run_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, null, "drained-task", stage, owner, null, null, "manual", now, now);
  return id;
}

function seedDrainedRun(db, taskId, { stage = "execute", mode = "execute", agentName = "coder" } = {}) {
  const runId = newRunId();
  const now = Date.now() - 60_000;
  const transcript = JSON.stringify({
    schema: "worklab.transcript-tail.v1",
    captured_at: now,
    turn_count: 2,
    turns: [{ assistant_text: "started reading the codebase", thinking: null, tool_uses: [], tool_results: [] }],
    resume_kind: "drained",
    drain_acknowledged: true,
  });
  db.prepare(
    `INSERT INTO task_runs
      (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status,
       failure_kind, cancel_initiator, cancel_reason, transcript_tail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'cancelled', 'cancelled',
             'cancelled_shutdown', 'coordinator_shutdown', 'coordinator stopping', ?)`,
  ).run(runId, taskId, mode, stage, agentName, now, now + 5_000, transcript);
  return runId;
}

function seedStaleDrainedRun(db, taskId, dataDir, { stage = "execute", mode = "execute", agentName = "coder" } = {}) {
  const runId = newRunId();
  const now = Date.now() - 60_000;
  const rawDir = join(dataDir, "logs", "runs");
  mkdirSync(rawDir, { recursive: true });
  const rawLogPath = join(rawDir, `${runId}.jsonl`);
  const events = [
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "I updated the admin CSS and was preparing to commit it." }] },
      _event_seq: 1,
    },
    {
      type: "drained",
      reason: "coordinator_shutdown",
      deadline_at: now + 60_000,
      ts: now + 5_000,
      _event_seq: 2,
    },
  ];
  writeFileSync(rawLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  db.prepare(
    `INSERT INTO task_runs
      (id, task_id, mode, stage, agent_name, started_at, status, process_status, raw_output_path)
     VALUES (?, ?, ?, ?, ?, ?, 'running', 'running', ?)`,
  ).run(runId, taskId, mode, stage, agentName, now, rawLogPath);
  return runId;
}

describe("coordinator resume — drained-snapshot recovery", () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDataDir() {
    const dir = mkdtempSync(join(tmpdir(), "worklab-drained-recovery-"));
    tempDirs.push(dir);
    return dir;
  }

  it("schedules a continuation with continuation_reason=coordinator_resume on boot", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db);
    const drainedRunId = seedDrainedRun(db, taskId);

    const broker = stubBroker();
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise(() => {}), // never resolves
      cancel: vi.fn(),
      drain: vi.fn(),
    }));
    const watcher = createTaskWatcher({
      db, broker, spawn, workerBinary: "/fake",
      repoRoot: "/repo", dataDir: "/data", workspace: "/work",
    });
    // Wait for the deferred bootstrap microtask.
    await watcher.coordinatorResumeBootstrap;
    // And a microtask cycle for spawn() side-effects to flush.
    await new Promise((r) => setImmediate(r));

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnCall = spawn.mock.calls[0][0];
    expect(spawnCall.diagnosticsSeed.continuation_reason).toBe("coordinator_resume");
    expect(spawnCall.diagnosticsSeed.continuation_of_run_id).toBe(drainedRunId);
    expect(spawnCall.diagnosticsSeed.resume_snapshot.resume_kind).toBe("drained");
    expect(spawnCall.diagnosticsSeed.resume_snapshot.turns?.length).toBeGreaterThan(0);

    const continuationRun = db.prepare(
      "SELECT id FROM task_runs WHERE task_id = ? AND id <> ? ORDER BY started_at DESC LIMIT 1",
    ).get(taskId, drainedRunId);
    expect(continuationRun).toBeTruthy();

    // Original drained run should be marked with continuation_run_id pointing
    // at the new continuation.
    const original = db.prepare("SELECT diagnostics_json FROM task_runs WHERE id = ?").get(drainedRunId);
    const diag = JSON.parse(original.diagnostics_json);
    expect(diag.continuation_reason).toBe("coordinator_resume");
    expect(diag.continuation_run_id).toBe(continuationRun.id);

    // (skip explicit shutdown — spawn().done never resolves in this test
    // double; Vitest tears the worker down at the end of the suite)
  });

  it("recovers a stale running row from a raw-log drained event before scheduling continuation", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db);
    const dataDir = tempDataDir();
    const drainedRunId = seedStaleDrainedRun(db, taskId, dataDir);

    const broker = stubBroker();
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise(() => {}),
      cancel: vi.fn(),
      drain: vi.fn(),
    }));
    const watcher = createTaskWatcher({
      db, broker, spawn, workerBinary: "/fake",
      repoRoot: "/repo", dataDir, workspace: "/work",
    });
    await watcher.coordinatorResumeBootstrap;
    await new Promise((r) => setImmediate(r));

    const recovered = db.prepare(
      "SELECT status, process_status, failure_kind, cancel_initiator, transcript_tail_json FROM task_runs WHERE id = ?",
    ).get(drainedRunId);
    expect(recovered.status).toBe("cancelled");
    expect(recovered.process_status).toBe("cancelled");
    expect(recovered.failure_kind).toBe("cancelled_shutdown");
    expect(recovered.cancel_initiator).toBe("coordinator_shutdown");
    const snapshot = JSON.parse(recovered.transcript_tail_json);
    expect(snapshot.resume_kind).toBe("drained");
    expect(snapshot.drain_acknowledged).toBe(true);
    expect(snapshot.turns?.[0]?.assistant_text).toContain("admin CSS");

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnCall = spawn.mock.calls[0][0];
    expect(spawnCall.diagnosticsSeed.continuation_reason).toBe("coordinator_resume");
    expect(spawnCall.diagnosticsSeed.continuation_of_run_id).toBe(drainedRunId);
    expect(spawnCall.diagnosticsSeed.resume_snapshot.resume_kind).toBe("drained");
  });

  it("does not re-schedule when a continuation row already exists", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db);
    const drainedRunId = seedDrainedRun(db, taskId);
    // Pre-existing continuation, modeled as a run row referencing the drained
    // run via diagnostics.continuation_of_run_id.
    const continuationId = newRunId();
    const now = Date.now();
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, status, process_status, diagnostics_json)
      VALUES (?, ?, 'execute', 'execute', 'coder', ?, 'running', 'running', ?)
    `).run(
      continuationId,
      taskId,
      now,
      JSON.stringify({ continuation_of_run_id: drainedRunId, continuation_reason: "coordinator_resume" }),
    );

    const spawn = vi.fn(() => ({ pid: 1, done: new Promise(() => {}), cancel: vi.fn(), drain: vi.fn() }));
    const watcher = createTaskWatcher({
      db, broker: stubBroker(), spawn, workerBinary: "/fake",
      repoRoot: "/repo", dataDir: "/data", workspace: "/work",
    });
    await watcher.coordinatorResumeBootstrap;
    await new Promise((r) => setImmediate(r));

    expect(spawn).not.toHaveBeenCalled();
    // (skip explicit shutdown — spawn().done never resolves in this test
    // double; Vitest tears the worker down at the end of the suite)
  });
});
