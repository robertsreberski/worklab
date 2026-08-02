import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnWorker } from "../../coordinator/spawn-worker.js";
import { makeTestDb } from "../helpers/test-db.js";
import { newRunId, newTaskId } from "../../core/ids.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeBinary = resolve(__dirname, "../helpers/fake-worker.js");

function stubBroker() {
  return {
    subscribe: () => {},
    unsubscribe: () => {},
    broadcast: () => {},
    size: () => 0,
  };
}

function seedTaskAndRun(db) {
  const taskId = newTaskId();
  const runId = newRunId();
  const now = Date.now();
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(taskId, "drain-timeout", now, now);
  db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("coder", "Coder", "claude", "claude:claude-sonnet-4-6", now, now);
  db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')")
    .run(runId, taskId, "execute", "coder", now);
  return { taskId, runId };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") return false;
    throw err;
  }
}

async function waitForProcessExit(pid, { timeoutMs = 2000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processAlive(pid);
}

describe("coordinator drain — timeout falls through to cancel", () => {
  it("worker that ignores drain is SIGTERM'd; failure_kind=cancelled_shutdown with drain_timeout: true", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = {
      events: [
        { type: "started", runId },
        {
          type: "sdk_event",
          delayMs: 10,
          event: {
            type: "assistant",
            message: { content: [{ type: "text", text: "ignoring drain" }] },
          },
        },
      ],
      ignoreDrain: true,
      // run a long time so the drain timer wins
      exitAfterMs: 5_000,
    };

    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId, WORKLAB_WORKSPACE: "/workspace" },
      runId, taskId, broker, db,
      runIdleWarningMs: 0,
      cancelGraceMs: 200,
      persistDebounceMs: 5,
    });

    await new Promise((r) => setTimeout(r, 60));
    handle.drain({ timeoutMs: 200 });
    const result = await handle.done;

    expect(result.failureKind).toBe("cancelled_shutdown");
    expect(result.diagnostics.drain_timeout).toBe(true);
    expect(result.diagnostics.drained).toBe(false);
    expect(result.cancelInitiator).toBe("coordinator_shutdown");

    const row = db.prepare("SELECT failure_kind, cancel_initiator, transcript_tail_json FROM task_runs WHERE id = ?").get(runId);
    expect(row.failure_kind).toBe("cancelled_shutdown");
    expect(row.cancel_initiator).toBe("coordinator_shutdown");
    // We still record a transcript snapshot even on timeout — the resume
    // path is best-effort.
    if (row.transcript_tail_json) {
      const snap = JSON.parse(row.transcript_tail_json);
      expect(snap.resume_kind).toBe("drained");
      expect(snap.drain_acknowledged).toBe(false);
      expect(snap.drain_timeout).toBe(true);
    }
  }, 10_000);

  it("cleans up long-lived child processes in the worker process group after exit", async () => {
    if (process.platform === "win32") return;

    const tempDir = mkdtempSync(join(tmpdir(), "worklab-worker-child-cleanup-"));
    const childPidFile = join(tempDir, "child.pid");
    let childPid = null;
    try {
      const db = makeTestDb();
      const broker = stubBroker();
      const { taskId, runId } = seedTaskAndRun(db);
      const script = {
        spawnChildPidFile: childPidFile,
        events: [{ type: "started", runId }],
        exitAfterMs: 25,
      };

      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
        env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
        runId,
        taskId,
        broker,
        db,
        runIdleWarningMs: 0,
        cancelGraceMs: 100,
        persistDebounceMs: 5,
      });

      const result = await handle.done;
      expect(result.processStatus).toBe("succeeded");
      expect(existsSync(childPidFile)).toBe(true);
      childPid = Number(readFileSync(childPidFile, "utf8").trim());
      expect(childPid).toBeGreaterThan(0);
      await expect(waitForProcessExit(childPid)).resolves.toBe(true);
    } finally {
      if (childPid && processAlive(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10_000);

  it("lets the worker semantically cancel before cleaning up its process group", async () => {
    if (process.platform === "win32") return;

    const tempDir = mkdtempSync(join(tmpdir(), "worklab-worker-semantic-cancel-"));
    const childPidFile = join(tempDir, "child.pid");
    let childPid = null;
    try {
      const db = makeTestDb();
      const broker = stubBroker();
      const { taskId, runId } = seedTaskAndRun(db);
      const script = {
        spawnChildPidFile: childPidFile,
        events: [{ type: "started", runId, delayMs: 750 }],
        exitAfterMs: 250,
      };

      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
        env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
        runId,
        taskId,
        broker,
        db,
        runIdleWarningMs: 0,
        cancelGraceMs: 2_000,
        persistDebounceMs: 5,
      });

      const pidDeadline = Date.now() + 2_000;
      while (!existsSync(childPidFile) && Date.now() < pidDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(childPidFile)).toBe(true);
      childPid = Number(readFileSync(childPidFile, "utf8").trim());
      expect(childPid).toBeGreaterThan(0);

      handle.cancel({ initiator: "api_cancel", reason: "semantic cancel regression" });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Initial cancellation targets the worker only. The descendant stands
      // in for an ACP bridge that must stay alive while the worker's abort
      // handler sends session/cancel and drains protocol cleanup.
      expect(processAlive(childPid)).toBe(true);

      const result = await handle.done;
      expect(result.failureKind).toBe("cancelled_user");
      await expect(waitForProcessExit(childPid)).resolves.toBe(true);
    } finally {
      if (childPid && processAlive(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10_000);
});
