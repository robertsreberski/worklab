import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("delivers live user messages over worker stdin and logs the accepted message", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = {
      events: [{ type: "started", runId }],
      echoControls: true,
      exitCode: 0,
      exitAfterMs: 500,
    };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      runIdleWarningMs: 0,
    });

    const delivery = await handle.sendLiveMessage({
      id: "comment-1",
      body: "Please focus on the failing test.",
      createdAt: 123,
    });

    expect(delivery).toEqual({ ok: true });

    let controlEvent = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      controlEvent = broker.broadcasts.find((item) => item.ch === runId && item.p.type === "control_seen");
      if (controlEvent) break;
    }

    expect(controlEvent?.p.message).toMatchObject({
      type: "live_user_message",
      id: "comment-1",
      body: "Please focus on the failing test.",
      created_at: 123,
      author_type: "human",
    });
    const liveEvent = broker.broadcasts.find((item) => item.ch === runId && item.p.type === "live_user_message");
    expect(liveEvent?.p).toMatchObject({
      message_id: "comment-1",
      body: "Please focus on the failing test.",
      created_at: 123,
      author_type: "human",
    });

    await handle.done;
  });

  it("records error status on nonzero exit", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = { events: [{ type: "error", message: "boom", failureKind: "provider_unavailable" }], exitCode: 1 };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("boom");
    expect(result.failureKind).toBe("provider_unavailable");
    const log = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(runId);
    expect(log.status).toBe("error");
    const run = db.prepare("SELECT failure_kind, error_text FROM task_runs WHERE id = ?").get(runId);
    expect(run).toMatchObject({ failure_kind: "provider_unavailable", error_text: "boom" });
  });

  it("stores full raw events while truncating large tool results in display logs", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const dataDir = mkdtempSync(resolve(tmpdir(), "worklab-spawn-"));
    const { taskId, runId } = seedTaskAndRun(db);
    const largeOutput = "x".repeat(80);
    const script = {
      events: [
        {
          type: "sdk_event",
          event: {
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "tool-1", content: largeOutput, is_error: false }],
            },
          },
        },
        { type: "final", text: "done" },
      ],
      exitCode: 0,
    };
    try {
      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
        env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
        runId, taskId, broker, db, dataDir, logInlineLimit: 20,
      });
      await handle.done;

      const run = db.prepare("SELECT raw_output_path FROM task_runs WHERE id = ?").get(runId);
      expect(run.raw_output_path).toContain(`${runId}.jsonl`);
      expect(readFileSync(run.raw_output_path, "utf8")).toContain(largeOutput);
      const displayEvents = JSON.parse(db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(runId).events);
      const resultBlock = displayEvents[0].event.message.content[0];
      expect(resultBlock.content).toContain("[truncated");
      expect(resultBlock.content.length).toBeLessThan(largeOutput.length);
      expect(resultBlock.truncated).toBe(true);
      expect(resultBlock.original_length).toBe(largeOutput.length);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("truncates large tool inputs and raw_result payloads only in display logs", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const dataDir = mkdtempSync(resolve(tmpdir(), "worklab-spawn-"));
    const { taskId, runId } = seedTaskAndRun(db);
    const largeInput = "i".repeat(80);
    const largeRawResult = "r".repeat(80);
    const script = {
      events: [
        {
          type: "sdk_event",
          event: {
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "tool-1", name: "kb_create", input: { body: largeInput } }],
            },
          },
        },
        {
          type: "sdk_event",
          event: {
            type: "user",
            message: {
              content: [{
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "ok",
                raw_result: { content: [{ type: "text", text: largeRawResult }] },
                is_error: false,
              }],
            },
          },
        },
        { type: "final", text: "done" },
      ],
      exitCode: 0,
    };
    try {
      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
        env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
        runId, taskId, broker, db, dataDir, logInlineLimit: 20,
      });
      await handle.done;

      const run = db.prepare("SELECT raw_output_path FROM task_runs WHERE id = ?").get(runId);
      const rawLog = readFileSync(run.raw_output_path, "utf8");
      expect(rawLog).toContain(largeInput);
      expect(rawLog).toContain(largeRawResult);

      const displayEvents = JSON.parse(db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(runId).events);
      const inputBlock = displayEvents[0].event.message.content[0];
      const resultBlock = displayEvents[1].event.message.content[0];
      expect(inputBlock.input_truncated).toBe(true);
      expect(inputBlock.input.preview).toContain("[truncated");
      expect(resultBlock.raw_result.truncated).toBe(true);
      expect(resultBlock.raw_result.preview).toContain("[truncated");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("records context-bloat diagnostics for broad scans and large tool payloads", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const largeOutput = [
      "/repo/src/app.js",
      "/repo/node_modules/pkg/index.js",
      "/repo/dist/assets/app.js.map",
      "x".repeat(120),
    ].join("\n");
    const script = {
      events: [
        {
          type: "sdk_event",
          event: {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: "glob-1",
                name: "Glob",
                input: { path: "/repo", pattern: "**/*" },
              }],
            },
          },
        },
        {
          type: "sdk_event",
          event: {
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "glob-1", content: largeOutput, is_error: false }],
            },
          },
        },
        { type: "final", text: "done" },
      ],
      exitCode: 0,
    };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      contextBloatEventChars: 80,
      contextBloatTotalChars: 80,
      runIdleWarningMs: 0,
    });
    const result = await handle.done;

    expect(result.warnings.find((warning) => warning.kind === "context_bloat")).toBeTruthy();
    expect(broker.broadcasts.find((item) => item.ch === runId && item.p.warning_kind === "context_bloat")).toBeTruthy();

    const run = db.prepare("SELECT diagnostics_json, warnings_json FROM task_runs WHERE id = ?").get(runId);
    const diagnostics = JSON.parse(run.diagnostics_json);
    expect(diagnostics.context_risk).toBe("high");
    expect(diagnostics.tool_payload_chars).toBeGreaterThan(largeOutput.length);
    expect(diagnostics.largest_tool_events[0]).toMatchObject({ tool: "Glob", role: "tool_result" });
    expect(diagnostics.broad_scan_events[0]).toMatchObject({ tool: "Glob", pattern: "**/*", path: "/repo" });
    expect(JSON.parse(run.warnings_json).find((warning) => warning.kind === "context_bloat")).toBeTruthy();
  });

  it("marks a run failed when the worker exceeds the run timeout", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = { events: [{ type: "started", runId }], exitCode: 0, exitAfterMs: 2000 };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      runTimeoutMs: 100,
      cancelGraceMs: 200,
      runIdleWarningMs: 0,
    });
    const result = await handle.done;
    expect(result.processStatus).toBe("failed");
    expect(result.error).toContain("run timed out");
    const run = db.prepare("SELECT process_status, failure_kind, error_text FROM task_runs WHERE id = ?").get(runId);
    expect(run.process_status).toBe("failed");
    expect(run.failure_kind).toBe("timeout");
    expect(run.error_text).toContain("run timed out");
  }, 10000);

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
    expect(result.failureKind).toBe("cancelled_user");
    const log = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(runId);
    expect(log.status).toBe("cancelled");
    const run = db.prepare("SELECT process_status, failure_kind FROM task_runs WHERE id = ?").get(runId);
    expect(run).toMatchObject({ process_status: "cancelled", failure_kind: "cancelled_user" });
  }, 10000);

  it("persists cancel_initiator and cancel_reason on the run row", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = { events: [{ type: "started", runId, delayMs: 80 }], exitCode: 0, exitAfterMs: 2000 };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      cancelGraceMs: 500,
    });
    setTimeout(() => handle.cancel({ initiator: "api_cancel", reason: "user clicked cancel" }), 120);
    const result = await handle.done;
    expect(result.cancelInitiator).toBe("api_cancel");
    expect(result.cancelReason).toBe("user clicked cancel");
    const run = db.prepare("SELECT cancel_initiator, cancel_reason FROM task_runs WHERE id = ?").get(runId);
    expect(run).toEqual({ cancel_initiator: "api_cancel", cancel_reason: "user clicked cancel" });
  }, 10000);

  it("classifies worker-reported raw signal cancellation without falling back to spawn", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = {
      events: [{
        type: "cancelled",
        initiator: "worker_signal",
        signal: "SIGTERM",
        reason: "worker received SIGTERM",
      }],
      exitCode: 130,
    };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      runIdleWarningMs: 0,
    });

    const result = await handle.done;
    expect(result.processStatus).toBe("cancelled");
    expect(result.failureKind).toBe("cancelled_signal");
    expect(result.cancelInitiator).toBe("worker_signal");
    expect(result.cancelReason).toBe("worker received SIGTERM");

    const run = db.prepare(
      "SELECT process_status, failure_kind, cancel_initiator, cancel_reason, diagnostics_json FROM task_runs WHERE id = ?",
    ).get(runId);
    expect(run).toMatchObject({
      process_status: "cancelled",
      failure_kind: "cancelled_signal",
      cancel_initiator: "worker_signal",
      cancel_reason: "worker received SIGTERM",
    });
    expect(JSON.parse(run.diagnostics_json)).toMatchObject({
      worker_cancel_signal: "SIGTERM",
      failure_kind: "cancelled_signal",
    });
  });

  it("classifies raw unattributed worker cancellation as signal cancellation, not user cancellation", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = {
      events: [{ type: "cancelled" }],
      exitCode: 130,
    };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      runIdleWarningMs: 0,
    });

    const result = await handle.done;
    expect(result.processStatus).toBe("cancelled");
    expect(result.failureKind).toBe("cancelled_signal");
    expect(result.cancelInitiator).toBeNull();
    expect(result.cancelReason).toBeNull();

    const run = db.prepare(
      "SELECT process_status, failure_kind, cancel_initiator, cancel_reason, diagnostics_json FROM task_runs WHERE id = ?",
    ).get(runId);
    expect(run).toMatchObject({
      process_status: "cancelled",
      failure_kind: "cancelled_signal",
      cancel_initiator: null,
      cancel_reason: null,
    });
    expect(JSON.parse(run.diagnostics_json)).toMatchObject({
      failure_kind: "cancelled_signal",
    });
  });

  it("collects runtime_warning events into warnings_json and persists diagnostics", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = {
      events: [
        { type: "runtime_warning", warning_kind: "mcp_init_failed", source: "mcp_init", message: "linear unreachable" },
        { type: "final", text: "ok", usage: { input_tokens: 1, output_tokens: 1 }, provider_session_id: "sess-42", cost_usd: 0.0001 },
      ],
      exitCode: 0,
    };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId, WORKLAB_EXECENV_PATH: "/tmp/execenv-42" },
      runId, taskId, broker, db,
    });
    const result = await handle.done;
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.find((w) => w.kind === "mcp_init_failed")).toBeTruthy();
    expect(result.providerSessionId).toBe("sess-42");
    expect(result.execenvPath).toBe("/tmp/execenv-42");
    expect(result.costUsd).toBeCloseTo(0.0001);
    const run = db.prepare(`
      SELECT warnings_json, diagnostics_json, provider_session_id, execenv_path, cost_usd
      FROM task_runs WHERE id = ?
    `).get(runId);
    const stored = JSON.parse(run.warnings_json);
    expect(stored.find((w) => w.kind === "mcp_init_failed").message).toContain("linear");
    const diag = JSON.parse(run.diagnostics_json);
    expect(diag.warning_count).toBeGreaterThanOrEqual(1);
    expect(diag.provider_session_id).toBe("sess-42");
    expect(run.provider_session_id).toBe("sess-42");
    expect(run.execenv_path).toBe("/tmp/execenv-42");
    expect(run.cost_usd).toBeCloseTo(0.0001);
  });
});
