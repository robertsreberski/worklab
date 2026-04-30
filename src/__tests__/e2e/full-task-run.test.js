// src/__tests__/e2e/full-task-run.test.js
//
// Modularization regression coverage. The existing run-lifecycle and
// review-lifecycle e2e tests cover the happy paths; this one pins down the
// failure, cancellation, and late-stdout finalization paths that the upcoming
// reorg touches most aggressively (spawn-worker.js, task-watcher.js,
// state-machine.js, task-side-effects.js).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../api/server.js";
import { openDb, runMigrations } from "../../core/db.js";
import { createTaskWatcher } from "../../coordinator/task-watcher.js";
import { spawnWorker } from "../../coordinator/spawn-worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeBinary = resolve(__dirname, "../helpers/fake-worker.js");

function makeSpawnFake(scriptByMode) {
  return (opts) => {
    const modeIdx = opts.args.indexOf("--mode");
    const mode = modeIdx >= 0 ? opts.args[modeIdx + 1] : "execute";
    const script = scriptByMode[mode] || scriptByMode.execute;
    return spawnWorker({
      ...opts,
      binary: fakeBinary,
      env: { ...opts.env, FAKE_WORKER_SCRIPT: JSON.stringify(script) },
    });
  };
}

async function pollTask(baseUrl, taskId, predicate, { timeoutMs = 5000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fetch(`${baseUrl}/api/tasks/${taskId}`).then((r) => r.json());
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return last;
}

async function createAgent(baseUrl, name) {
  const res = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, display_name: name, sdk: "claude", model: "claude:claude-sonnet-4-6" }),
  });
  expect(res.status).toBe(201);
}

async function createTask(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()).task;
}

async function requestRun(baseUrl, taskId) {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/run`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()).runId;
}

function setupHarness(scriptByMode) {
  const tmp = mkdtempSync(join(tmpdir(), "worklab-e2e-full-run-"));
  const db = openDb(join(tmp, "test.db"));
  runMigrations(db);

  const watcherHolder = { current: null };
  const watcherProxy = {
    handleRunRequested: (...a) => watcherHolder.current.handleRunRequested(...a),
    cancel: (...a) => watcherHolder.current.cancel(...a),
    shutdown: (...a) => watcherHolder.current.shutdown(...a),
    isActive: (...a) => watcherHolder.current.isActive(...a),
  };
  const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
  const { app, broker } = createServer({ db, logger: silentLogger, watcher: watcherProxy, dataDir: tmp });

  watcherHolder.current = createTaskWatcher({
    db,
    broker,
    spawn: makeSpawnFake(scriptByMode),
    workerBinary: fakeBinary,
    repoRoot: tmp,
    dataDir: tmp,
    logger: silentLogger,
  });

  const http = createHttpServer(app);
  return new Promise((resolve) => {
    http.listen(0, () => {
      resolve({
        baseUrl: `http://localhost:${http.address().port}`,
        watcher: watcherProxy,
        teardown: async () => {
          await watcherProxy.shutdown();
          await new Promise((r) => http.close(() => r()));
          db.close();
          rmSync(tmp, { recursive: true, force: true });
        },
      });
    });
  });
}

describe("e2e: full task lifecycle regressions", () => {
  let savedAnthropicKey;
  let harness;

  beforeEach(() => {
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  });

  afterEach(async () => {
    if (harness) await harness.teardown();
    harness = null;
    if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  });

  it("worker exit-code 1 leaves the task retryable in execute (no retry dead end)", async () => {
    harness = await setupHarness({
      execute: {
        events: [
          { type: "started", ts: Date.now() },
          { type: "fatal", message: "synthetic crash" },
        ],
        exitCode: 1,
      },
    });
    await createAgent(harness.baseUrl, "owner");
    const task = await createTask(harness.baseUrl, { title: "fail run", owner_agent: "owner", stage: "execute" });
    await requestRun(harness.baseUrl, task.id);

    const after = await pollTask(harness.baseUrl, task.id, (t) => t.task.last_failure_kind);
    // Stage stays in execute (the retry-dead-end fix). retry_count is now 1.
    expect(after.task.stage).toBe("execute");
    expect(after.task.retry_count).toBe(1);
    expect(after.task.last_failure_kind).toBeTruthy();

    // A second run can still be requested — the audit's "retry dead end".
    const second = await fetch(`${harness.baseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(second.status).toBe(200);
  }, 30000);

  it("captures the final event when the worker exits immediately after writing it (no late-stdout drop)", async () => {
    // exitAfterMs:0 + delayMs:0 forces the close-vs-exit race the audit warned
    // about. spawn-worker.js currently finalizes on `close` with an exit-watchdog
    // fallback; this test pins that contract so the upcoming refactor cannot
    // accidentally regress to exit-only finalization.
    harness = await setupHarness({
      execute: {
        events: [
          { type: "started", ts: Date.now() },
          {
            type: "final",
            text: "done quickly",
            usage: { input_tokens: 7, output_tokens: 3 },
            durationMs: 1,
            numTurns: 1,
            model: "claude-sonnet-4-6",
            effort: "medium",
          },
        ],
        exitCode: 0,
        exitAfterMs: 0,
      },
    });
    await createAgent(harness.baseUrl, "owner");
    const task = await createTask(harness.baseUrl, { title: "fast run", owner_agent: "owner", stage: "execute" });
    const runId = await requestRun(harness.baseUrl, task.id);

    const finalTask = await pollTask(harness.baseUrl, task.id, (t) => t.task.stage === "done");
    expect(finalTask.task.stage).toBe("done");
    const runRes = await fetch(`${harness.baseUrl}/api/runs/${runId}`).then((r) => r.json());
    expect(runRes.run.status).toBe("complete");
    expect(runRes.log.input_tokens).toBe(7);
    expect(runRes.log.output_tokens).toBe(3);
  }, 30000);

  it("user-initiated cancel keeps the task retryable with a cancellation reason", async () => {
    // Long-running fake worker: SIGTERM lands during the 1.5s sleep before it
    // reaches the final event. The cancel path should not increment retry_count.
    harness = await setupHarness({
      execute: {
        events: [
          { type: "started", ts: Date.now() },
          { type: "final", text: "should never finish", delayMs: 1500 },
        ],
        exitCode: 0,
      },
    });
    await createAgent(harness.baseUrl, "owner");
    const task = await createTask(harness.baseUrl, { title: "cancel run", owner_agent: "owner", stage: "execute" });
    const runId = await requestRun(harness.baseUrl, task.id);

    // Wait until the run row reflects the running worker, then cancel.
    await pollTask(harness.baseUrl, task.id, async () => {
      const run = await fetch(`${harness.baseUrl}/api/runs/${runId}`).then((r) => r.json());
      return run?.run?.worker_pid;
    }, { timeoutMs: 3000, stepMs: 50 });
    const cancelRes = await fetch(`${harness.baseUrl}/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect([200, 204]).toContain(cancelRes.status);

    const after = await pollTask(harness.baseUrl, task.id, (t) => {
      const reason = t.task.stage_reason || "";
      return reason.includes("cancel");
    });
    expect(after.task.stage).toBe("execute");
    expect(after.task.retry_count ?? 0).toBe(0);
    expect(after.task.stage_reason).toMatch(/cancel/);
  }, 30000);
});
