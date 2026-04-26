import { describe, it, expect, vi } from "vitest";
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
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(taskId, "smoke", now, now);
  db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("coder", "Coder", "claude", "claude:claude-sonnet-4-6", now, now);
  db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')")
    .run(runId, taskId, mode, "coder", now);
  return { taskId, runId };
}

describe("spawnWorker", () => {
  it("streams fake-worker stdout events through broker and resolves on clean exit", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = {
      events: [
        { type: "started", runId, ts: Date.now() },
        { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } } },
        { type: "final", text: "hi", usage: { input_tokens: 5, output_tokens: 2 }, durationMs: 42, numTurns: 1 },
      ],
      exitCode: 0,
    };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      persistDebounceMs: 10,
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    expect(result.finalText).toBe("hi");
    expect(result.usage.input_tokens).toBe(5);
    const types = broker.broadcasts.filter(b => b.ch === runId).map(b => b.p.type);
    expect(types).toContain("started");
    expect(types).toContain("sdk_event");
    expect(types).toContain("final");
    expect(broker.broadcasts.find(b => b.ch === runId && b.p.type === "started").p._event_seq).toBe(1);
    const log = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(runId);
    expect(log).toBeTruthy();
    expect(log.status).toBe("complete");
    expect(log.input_tokens).toBe(5);
    const events = JSON.parse(log.events);
    expect(events.length).toBe(3);
    expect(events.map((event) => event._event_seq)).toEqual([1, 2, 3]);
  });

  it("persists running events before the worker exits", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = {
      events: [
        { type: "started", runId },
        { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "text", text: "mid-run" }] } }, delayMs: 50 },
      ],
      exitCode: 0,
      exitAfterMs: 500,
    };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
    });

    let runningLog = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      runningLog = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(runId);
      if (JSON.parse(runningLog?.events || "[]").length >= 2) break;
    }

    expect(runningLog.status).toBe("running");
    expect(JSON.parse(runningLog.events).map((event) => event._event_seq)).toEqual([1, 2]);

    await handle.done;
    const rows = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").all(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("complete");
  });

  it("records error status on nonzero exit", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = { events: [{ type: "error", message: "boom" }], exitCode: 1 };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("boom");
    const log = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(runId);
    expect(log.status).toBe("error");
  });

  it("cancel() sends SIGTERM, worker exits 130, status=cancelled", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = { events: [{ type: "started", runId, delayMs: 100 }], exitCode: 0, exitAfterMs: 2000 };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      cancelGraceMs: 500,
    });
    setTimeout(() => handle.cancel(), 150);
    const result = await handle.done;
    expect([130, null]).toContain(result.exitCode);
    const log = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(runId);
    expect(log.status).toBe("cancelled");
  }, 10000);
});
