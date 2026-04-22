// src/__tests__/e2e/review-lifecycle.test.js
//
// End-to-end test of the reviewer loop: HTTP → task-watcher → fake worker
// (execute mode → review mode) → DB → agent comments → task status transition.
//
// Two scenarios:
//   A) APPROVE path — reviewer approves, task transitions to `done`.
//   B) REJECT  path — reviewer rejects, task returns to `in_progress`.
//
// NOTE: Verification that pinned KB reaches the reviewer/executor system prompt
// is covered by context.test.js (direct builder tests) and a worker-side
// integration check deferred to T14 / Phase 4. The fake worker never receives
// a system prompt from the coordinator (it's a pure stub), so we cannot assert
// KB injection here.
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

/**
 * Build a spawn wrapper that feeds a different FAKE_WORKER_SCRIPT per mode,
 * detected from the args array (`--mode execute` or `--mode review`).
 * `executeEvents` / `reviewEvents` are arrays of raw events to emit.
 */
function makeSpawnFake({ executeEvents, reviewEvents }) {
  return (opts) => {
    const modeIdx = opts.args.indexOf("--mode");
    const mode = modeIdx >= 0 ? opts.args[modeIdx + 1] : "execute";
    const events = mode === "review" ? reviewEvents : executeEvents;
    return spawnWorker({
      ...opts,
      binary: fakeBinary,
      env: {
        ...opts.env,
        FAKE_WORKER_SCRIPT: JSON.stringify({ events, exitCode: 0 }),
      },
    });
  };
}

async function pollTaskUntil(baseUrl, taskId, predicate, { timeoutMs = 5000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const resp = await fetch(`${baseUrl}/api/tasks/${taskId}`).then((r) => r.json());
    last = resp;
    if (predicate(resp)) return resp;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return last;
}

async function createAgent(baseUrl, name, display_name) {
  const res = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, display_name, sdk: "claude", model: "sonnet" }),
  });
  expect(res.status).toBe(201);
}

function setupHarness({ executeEvents, reviewEvents }) {
  const tmp = mkdtempSync(join(tmpdir(), "worklab-e2e-review-"));
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

  const spawnFake = makeSpawnFake({ executeEvents, reviewEvents });
  watcherHolder.current = createTaskWatcher({
    db, broker, spawn: spawnFake, workerBinary: fakeBinary, repoRoot: tmp, dataDir: tmp, logger: silentLogger,
  });

  const http = createHttpServer(app);
  return new Promise((resolveFn) => {
    http.listen(0, () => {
      const baseUrl = `http://localhost:${http.address().port}`;
      resolveFn({ http, baseUrl, tmp, db, watcher: watcherHolder.current });
    });
  });
}

async function teardownHarness(ctx) {
  await ctx.watcher.shutdown();
  await new Promise((r) => ctx.http.close(r));
  ctx.db.close();
  rmSync(ctx.tmp, { recursive: true, force: true });
}

describe("e2e: reviewer lifecycle (APPROVE / REJECT) via fake worker", () => {
  let ctx;

  afterEach(async () => {
    if (ctx) {
      await teardownHarness(ctx);
      ctx = null;
    }
  });

  it("APPROVE path: task → in_review → done, with executor + reviewer + system comments", async () => {
    const runIdRef = { execute: null, review: null };
    ctx = await setupHarness({
      executeEvents: [
        // Worker emits started / sdk / final. runId placeholder is not actually used by coordinator.
        { type: "started", ts: Date.now() },
        { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } } },
        { type: "final", text: "all good", usage: { input_tokens: 5, output_tokens: 3 }, durationMs: 100, numTurns: 1, model: "claude-sonnet-4-6", effort: "medium" },
      ],
      reviewEvents: [
        { type: "started", ts: Date.now() },
        { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "text", text: "reviewing" }] } } },
        { type: "verdict", verdict: "APPROVE", notes: "" },
        { type: "final", text: "VERDICT: APPROVE\n\nLooks good", usage: { input_tokens: 8, output_tokens: 4 }, durationMs: 80, numTurns: 1, model: "claude-sonnet-4-6", effort: "medium" },
      ],
    });
    void runIdRef;

    await createAgent(ctx.baseUrl, "exec", "Exec Agent");
    await createAgent(ctx.baseUrl, "reviewer", "Reviewer Agent");

    const taskRes = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "e2e approve", executor_agent: "exec", reviewer_agent: "reviewer" }),
    });
    expect(taskRes.status).toBe(201);
    const { task } = await taskRes.json();

    const runRes = await fetch(`${ctx.baseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(runRes.status).toBe(200);

    const finalResp = await pollTaskUntil(
      ctx.baseUrl,
      task.id,
      (tr) => tr.task.status === "done",
      { timeoutMs: 5000, stepMs: 100 },
    );

    expect(finalResp.task.status).toBe("done");
    expect(finalResp.task.completed_at).not.toBeNull();

    // task_runs: exactly 2 rows — execute (complete) + review (complete).
    const runs = ctx.db
      .prepare("SELECT mode, status, agent_name FROM task_runs WHERE task_id = ? ORDER BY started_at ASC")
      .all(task.id);
    expect(runs.length).toBe(2);
    expect(runs[0]).toMatchObject({ mode: "execute", status: "complete", agent_name: "exec" });
    expect(runs[1]).toMatchObject({ mode: "review", status: "complete", agent_name: "reviewer" });

    // Comments: executor agent (exec, "all good"), reviewer agent (reviewer, contains "Looks good"),
    // system ("VERDICT: APPROVE").
    const comments = finalResp.comments;
    const execComments = comments.filter((c) => c.author_type === "agent" && c.author_id === "exec");
    const reviewerComments = comments.filter((c) => c.author_type === "agent" && c.author_id === "reviewer");
    const systemComments = comments.filter((c) => c.author_type === "system");

    expect(execComments.length).toBe(1);
    expect(execComments[0].body).toBe("all good");

    expect(reviewerComments.length).toBe(1);
    expect(reviewerComments[0].body).toContain("Looks good");

    expect(systemComments.some((c) => c.body === "VERDICT: APPROVE")).toBe(true);
  }, 15000);

  it("REJECT path: task → in_review → in_progress, with reviewer + system rejection comments", async () => {
    const rejectionNotes = "- fix X\n- fix Y";
    ctx = await setupHarness({
      executeEvents: [
        { type: "started", ts: Date.now() },
        { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } } },
        { type: "final", text: "tried my best", usage: { input_tokens: 5, output_tokens: 3 }, durationMs: 100, numTurns: 1, model: "claude-sonnet-4-6", effort: "medium" },
      ],
      reviewEvents: [
        { type: "started", ts: Date.now() },
        { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "text", text: "reviewing" }] } } },
        { type: "verdict", verdict: "REJECT", notes: rejectionNotes },
        { type: "final", text: `VERDICT: REJECT\n\n${rejectionNotes}`, usage: { input_tokens: 8, output_tokens: 4 }, durationMs: 80, numTurns: 1, model: "claude-sonnet-4-6", effort: "medium" },
      ],
    });

    await createAgent(ctx.baseUrl, "exec", "Exec Agent");
    await createAgent(ctx.baseUrl, "reviewer", "Reviewer Agent");

    const taskRes = await fetch(`${ctx.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "e2e reject", executor_agent: "exec", reviewer_agent: "reviewer" }),
    });
    expect(taskRes.status).toBe(201);
    const { task } = await taskRes.json();

    const runRes = await fetch(`${ctx.baseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(runRes.status).toBe(200);

    // First wait until we've reached in_review, then wait for the reviewer to bounce it back.
    const finalResp = await pollTaskUntil(
      ctx.baseUrl,
      task.id,
      (tr) => tr.task.status === "in_progress" && tr.comments.some((c) => c.author_type === "system" && c.body.includes("fix X")),
      { timeoutMs: 5000, stepMs: 100 },
    );

    expect(finalResp.task.status).toBe("in_progress");
    // Reducer's clear_error_text side effect on review_rejected clears error_text.
    expect(finalResp.task.error_text).toBeNull();

    // task_runs: 2 rows — execute (complete) + review (complete). The review run still
    // completed at the worker level; it's the verdict that routes the task back.
    const runs = ctx.db
      .prepare("SELECT mode, status, agent_name FROM task_runs WHERE task_id = ? ORDER BY started_at ASC")
      .all(task.id);
    expect(runs.length).toBe(2);
    expect(runs[0]).toMatchObject({ mode: "execute", status: "complete", agent_name: "exec" });
    expect(runs[1]).toMatchObject({ mode: "review", status: "complete", agent_name: "reviewer" });

    // Reviewer agent comment with final text (contains rejection notes).
    const reviewerComments = finalResp.comments.filter((c) => c.author_type === "agent" && c.author_id === "reviewer");
    expect(reviewerComments.length).toBe(1);
    expect(reviewerComments[0].body).toContain("fix X");
    expect(reviewerComments[0].body).toContain("fix Y");

    // System rejection comment posted via post_review_comment side effect.
    const systemComments = finalResp.comments.filter((c) => c.author_type === "system");
    expect(systemComments.some((c) => c.body.includes("fix X") && c.body.includes("fix Y"))).toBe(true);
  }, 15000);
});
