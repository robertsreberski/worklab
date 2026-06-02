import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnWorker } from "../../coordinator/spawn-worker.js";
import { makeTestDb } from "../helpers/test-db.js";
import { newRunId, newTaskId } from "../../core/ids.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeBinary = resolve(__dirname, "../helpers/fake-worker.js");

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

function seedTaskAndRun(db, { mode = "execute" } = {}) {
  const taskId = newTaskId();
  const runId = newRunId();
  const now = Date.now();
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(taskId, "drain-test", now, now);
  db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("coder", "Coder", "claude", "claude:claude-sonnet-4-6", now, now);
  db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')")
    .run(runId, taskId, mode, "coder", now);
  return { taskId, runId };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for drain test condition");
}

describe("coordinator drain — clean drain within timeout", () => {
  it("worker emits drained, exits 0; row marked cancelled_shutdown with transcript_tail snapshot", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = {
      events: [
        { type: "started", runId },
        {
          type: "sdk_event",
          delayMs: 30,
          event: {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "starting work" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x" } }],
            },
          },
        },
        {
          type: "sdk_event",
          delayMs: 30,
          event: {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
          },
        },
      ],
      drain: { emitDrained: true, emitCancelled: true, exitCode: 0, exitAfterMs: 5 },
      // exitAfterMs gives the events time to flow before the drain message arrives
      exitAfterMs: 1000,
    };

    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId, WORKLAB_WORKSPACE: "/workspace" },
      runId, taskId, broker, db,
      runIdleWarningMs: 0,
      persistDebounceMs: 5,
    });

    // Let the transcript-worthy provider events flow before draining.
    await waitFor(() => broker.broadcasts
      .filter(({ ch, p }) => ch === runId && p?.type === "sdk_event")
      .length >= 2);
    await handle.drain({ timeoutMs: 2000 });
    const result = await handle.done;

    expect(result.processStatus).toBe("cancelled");
    expect(result.failureKind).toBe("cancelled_shutdown");
    expect(result.diagnostics.drained).toBe(true);
    expect(result.diagnostics.drain_timeout).toBeUndefined();

    const row = db.prepare("SELECT failure_kind, cancel_initiator, transcript_tail_json FROM task_runs WHERE id = ?").get(runId);
    expect(row.failure_kind).toBe("cancelled_shutdown");
    expect(row.cancel_initiator).toBe("coordinator_shutdown");
    expect(row.transcript_tail_json).toBeTruthy();
    const snapshot = JSON.parse(row.transcript_tail_json);
    expect(snapshot.resume_kind).toBe("drained");
    expect(snapshot.drain_acknowledged).toBe(true);
    expect(Array.isArray(snapshot.turns)).toBe(true);
    expect(snapshot.turns.length).toBeGreaterThan(0);
  }, 10_000);
});
