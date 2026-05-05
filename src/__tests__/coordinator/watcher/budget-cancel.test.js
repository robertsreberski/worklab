// Integration coverage for the settings-backed run-turn budget guardrail wired
// into spawn-worker. We synthesise a runaway run (many tool_results emitted
// quickly) with tight settings and assert:
//
//   - the watcher emits a budget_soft warning + posts a system comment
//     when the soft threshold is crossed;
//   - the watcher emits a budget_exceeded warning, cancels the worker, and
//     marks the run failure_kind=budget_exceeded once the hard threshold
//     is crossed;
//   - the warning + diagnostics survive into task_runs.diagnostics_json.
//
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { spawnWorker } from "../../../coordinator/spawn-worker.js";
import { makeTestDb } from "../../helpers/test-db.js";
import { newRunId, newTaskId } from "../../../core/ids.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeBinary = resolve(__dirname, "../../helpers/fake-worker.js");

function stubBroker() {
  const broadcasts = [];
  return {
    broadcasts,
    subscribe: () => {},
    unsubscribe: () => {},
    broadcast: (ch, p) => broadcasts.push({ ch, p }),
    size: () => 0,
  };
}

function seedTaskAndRun(db) {
  const taskId = newTaskId();
  const runId = newRunId();
  const now = Date.now();
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(taskId, "runaway-runtime-engineer", now, now);
  db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("runtime-engineer", "Runtime Engineer", "claude", "claude:claude-sonnet-4-6", now, now);
  db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')")
    .run(runId, taskId, "execute", "runtime-engineer", now);
  return { taskId, runId };
}

function makeToolResultEvent(toolUseId) {
  return {
    type: "sdk_event",
    event: {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: "ok",
          is_error: false,
        }],
      },
    },
  };
}

describe("spawn-worker run-turn budget guardrail", () => {
  it("cancels a runaway run at the hard num_turns threshold and persists budget_exceeded", async () => {
    const db = makeTestDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("agent_budget_soft_turns", JSON.stringify(2));
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("agent_budget_hard_turns", JSON.stringify(3));
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);

    const events = [];
    // Hard num_turns = 3 catches the runaway almost immediately. We push
    // many more in case the cancel takes a moment to propagate; the worker
    // will SIGTERM-exit on its own once cancel() lands.
    for (let i = 0; i < 20; i += 1) {
      events.push({ ...makeToolResultEvent(`t-${i}`), delayMs: 5 });
    }
    events.push({ type: "final", text: "done" });
    const script = { events, exitCode: 0, exitAfterMs: 800 };

    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "runtime-engineer"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      runIdleWarningMs: 0,
      cancelGraceMs: 200,
      agentName: "runtime-engineer",
    });
    const result = await handle.done;

    expect(result.processStatus).toBe("cancelled");
    expect(result.failureKind).toBe("budget_exceeded");
    expect(result.cancelInitiator).toBe("budget");
    expect(result.cancelReason).toMatch(/hard budget exceeded/i);

    const softWarnings = result.warnings.filter((w) => w.kind === "budget_soft");
    const hardWarnings = result.warnings.filter((w) => w.kind === "budget_exceeded");
    expect(softWarnings).toHaveLength(1);
    expect(hardWarnings).toHaveLength(1);

    const run = db.prepare(
      "SELECT process_status, failure_kind, cancel_initiator, cancel_reason, warnings_json, diagnostics_json FROM task_runs WHERE id = ?",
    ).get(runId);
    expect(run.process_status).toBe("cancelled");
    expect(run.failure_kind).toBe("budget_exceeded");
    expect(run.cancel_initiator).toBe("budget");

    const warnings = JSON.parse(run.warnings_json);
    expect(warnings.find((w) => w.kind === "budget_soft")).toBeTruthy();
    expect(warnings.find((w) => w.kind === "budget_exceeded")).toBeTruthy();

    const diag = JSON.parse(run.diagnostics_json);
    expect(diag.failure_kind).toBe("budget_exceeded");
    expect(diag.cancel_initiator).toBe("budget");

    // The watcher should have inserted a system comment for both the soft
    // and the hard breach. The comments table is the audit trail the
    // operator looks at when triaging a runaway run.
    const comments = db.prepare(
      "SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'system' ORDER BY created_at",
    ).all(taskId);
    expect(comments.length).toBeGreaterThanOrEqual(2);
    expect(comments[0].body).toMatch(/Soft budget threshold crossed/);
    expect(comments[1].body).toMatch(/Run cancelled/);
  }, 10_000);

  it("emits only the soft warning when stats stay under the hard threshold", async () => {
    const db = makeTestDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("agent_budget_soft_turns", JSON.stringify(2));
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("agent_budget_hard_turns", JSON.stringify(100));
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);

    const script = {
      events: [
        makeToolResultEvent("t-1"),
        makeToolResultEvent("t-2"),
        makeToolResultEvent("t-3"),
        { type: "final", text: "done" },
      ],
      exitCode: 0,
    };

    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "runtime-engineer"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      runIdleWarningMs: 0,
      agentName: "runtime-engineer",
    });
    const result = await handle.done;

    expect(result.processStatus).toBe("succeeded");
    expect(result.failureKind).toBeNull();
    const softWarnings = result.warnings.filter((w) => w.kind === "budget_soft");
    const hardWarnings = result.warnings.filter((w) => w.kind === "budget_exceeded");
    expect(softWarnings).toHaveLength(1);
    expect(hardWarnings).toHaveLength(0);

    const comments = db.prepare(
      "SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'system' ORDER BY created_at",
    ).all(taskId);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toMatch(/Soft budget threshold crossed/);
  });

  it("does not warn when no thresholds are crossed", async () => {
    const db = makeTestDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("agent_budget_soft_turns", JSON.stringify(100));
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("agent_budget_hard_turns", JSON.stringify(200));
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);

    const script = {
      events: [
        makeToolResultEvent("t-1"),
        { type: "final", text: "done" },
      ],
      exitCode: 0,
    };

    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "runtime-engineer"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      runIdleWarningMs: 0,
      agentName: "runtime-engineer",
    });
    const result = await handle.done;
    expect(result.processStatus).toBe("succeeded");
    expect(result.warnings.filter((w) => w.kind?.startsWith("budget_"))).toHaveLength(0);
    const comments = db.prepare(
      "SELECT id FROM task_comments WHERE task_id = ? AND author_type = 'system'",
    ).all(taskId);
    expect(comments).toHaveLength(0);
  });
});
