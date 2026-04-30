// src/__tests__/e2e/run-lifecycle.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../api/server.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import { createTaskWatcher } from "../../coordinator/task-watcher.js";
import { spawnWorker } from "../../coordinator/spawn-worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeBinary = resolve(__dirname, "../helpers/fake-worker.js");

describe("e2e: full run lifecycle via fake worker", () => {
  let http, baseUrl, tmp, db;
  let savedAnthropicKey;

  beforeAll(async () => {
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    tmp = mkdtempSync(join(tmpdir(), "worklab-e2e-run-"));
    db = openDb(join(tmp, "test.db"));
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

    // Inject fake worker via a spawn wrapper that sets FAKE_WORKER_SCRIPT
    const spawnFake = (opts) => spawnWorker({
      ...opts,
      binary: fakeBinary,
      env: {
        ...opts.env,
        FAKE_WORKER_SCRIPT: JSON.stringify({
          events: [
            { type: "started", runId: opts.runId, ts: Date.now() },
            { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "text", text: "hello from fake" }] } } },
            { type: "final", text: "hello from fake", usage: { input_tokens: 10, output_tokens: 5 }, durationMs: 50, numTurns: 1, model: "claude-sonnet-4-6", effort: "medium" },
          ],
          exitCode: 0,
        }),
      },
    });
    watcherHolder.current = createTaskWatcher({
      db, broker, spawn: spawnFake, workerBinary: fakeBinary, repoRoot: tmp, dataDir: tmp, logger: silentLogger,
    });

    http = createHttpServer(app);
    await new Promise(r => http.listen(0, r));
    baseUrl = `http://localhost:${http.address().port}`;
  }, 20000);

  afterAll(async () => {
    await new Promise(r => http.close(r));
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  });

  it("create agent → create task → run → auto-flip to done (no reviewer) → final comment posted", async () => {
    // Create agent
    let res = await fetch(`${baseUrl}/api/agents`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-coder", display_name: "E2E Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" }),
    });
    expect(res.status).toBe(201);

    // Create task with owner in execute stage
    res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "e2e run", owner_agent: "e2e-coder", stage: "execute" }),
    });
    expect(res.status).toBe(201);
    const { task } = await res.json();

    // Request run
    res = await fetch(`${baseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const { runId } = await res.json();

    // Wait up to 5s for the task to reach a terminal state. With no reviewer
    // assigned, the owner's "advance" decision lands the task in "done"
    // immediately rather than parking it in review indefinitely.
    let finalTask;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      const tr = await fetch(`${baseUrl}/api/tasks/${task.id}`).then(r => r.json());
      if (tr.task.stage === "done") { finalTask = tr; break; }
    }
    expect(finalTask?.task.stage).toBe("done");
    expect(finalTask?.task.completed_at).toBeTruthy();

    // Agent comment posted with the final text
    const agentComments = finalTask.comments.filter(c => c.author_type === "agent");
    expect(agentComments.length).toBe(1);
    expect(agentComments[0].body).toBe("hello from fake");

    // Run log persisted
    const runRes = await fetch(`${baseUrl}/api/runs/${runId}`).then(r => r.json());
    expect(runRes.run.status).toBe("complete");
    expect(runRes.log.events.length).toBeGreaterThan(0);
    expect(runRes.log.input_tokens).toBe(10);
  }, 30000);
});
