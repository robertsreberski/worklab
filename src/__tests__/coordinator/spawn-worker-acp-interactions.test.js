import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import { spawnWorker } from "../../coordinator/spawn-worker.js";
import { createAcpInteractionControls } from "../../coordinator/spawn-worker/acp-interactions.js";
import { insertAcpInteractionRequest } from "../../core/db/queries/acp-interactions.js";
import { createServer } from "../../api/server.js";
import { createAdminToolHandlers } from "../../mcp/admin/tools/index.js";
import { makeTestDb } from "../helpers/test-db.js";
import { sameOriginTestAgent } from "../helpers/test-server.js";
import { newRunId, newTaskId } from "../../core/ids.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fakeBinary = resolve(testDirectory, "../helpers/fake-worker.js");

function seed(db) {
  const taskId = newTaskId();
  const runId = newRunId();
  const now = Date.now();
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(taskId, "ACP interaction", now, now);
  db.prepare(`INSERT INTO agents
    (name, display_name, sdk, model, execution_mode, created_at, updated_at)
    VALUES ('external', 'External', 'acp', 'acp:profile-1', 'acp', ?, ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO acp_profiles
    (id, agent_name, driver, command, args_json, env_keys_json,
     configuration_owner, workspace_owner, mcp_owner, created_at, updated_at)
    VALUES ('profile-1', 'external', 'generic', '/bin/sh', '[]', '[]',
            'client', 'client', 'client', ?, ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO task_runs
    (id, task_id, mode, agent_name, provider_kind, started_at, status, process_status)
    VALUES (?, ?, 'execute', 'external', 'acp', ?, 'running', 'running')`)
    .run(runId, taskId, now);
  return { taskId, runId };
}

function broker() {
  return { broadcast: () => {}, subscribe: () => {}, unsubscribe: () => {}, size: () => 0 };
}

async function waitForRow(db, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = db.prepare("SELECT * FROM acp_interactions WHERE id = ?").get(id);
    if (row) return row;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("interaction row was not persisted");
}

describe("spawnWorker ACP interactions", () => {
  it("persists the request, delivers values only over stdin, and stores disposition only", async () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-private-session-"));
    try {
      const { taskId, runId } = seed(db);
      const sentinel = "task-run-request-secret-sentinel";
      const rawSessionId = "RAW_REMOTE_SESSION_DO_NOT_PERSIST";
      let deeplyNestedSession = { sessionId: rawSessionId };
      for (let depth = 0; depth < 25; depth += 1) {
        deeplyNestedSession = { nested: deeplyNestedSession };
      }
      const script = {
        ackAcpControls: true,
        echoControls: true,
        echoControlsToStderr: true,
        events: [{
          type: "acp_interaction_requested",
          interaction_id: "interaction-1",
          protocol_request_id: "rpc-1",
          profile_id: "profile-1",
          interaction_kind: "elicitation",
          request: {
            sessionId: rawSessionId,
            mode: "form",
            message: "Choose",
            _meta: { nested: { session_id: rawSessionId } },
            requestedSchema: {
              type: "object",
              default: sentinel,
              examples: [sentinel],
              content: { value: sentinel },
              properties: {
                password: { type: "string", default: sentinel, apiKey: sentinel },
              },
            },
            url: `https://example.test/form?token=${sentinel}#${sentinel}`,
          },
        }, {
          type: "sdk_event",
          event: {
            type: "acp_session_update",
            sessionId: rawSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              nested: { session_id: rawSessionId },
              deeplyNestedSession,
            },
          },
        }],
        exitAfterMs: 250,
      };
      const broadcasts = [];
      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "external"],
        env: {
          FAKE_WORKER_SCRIPT: JSON.stringify(script),
          WORKLAB_RUN_ID: runId,
          WORKLAB_DATA_DIR: dataDir,
        },
        runId,
        taskId,
        broker: {
          broadcast: (...args) => broadcasts.push(args),
          subscribe: () => {},
          unsubscribe: () => {},
          size: () => 0,
        },
        db,
        runIdleWarningMs: 0,
      });
      const pending = await waitForRow(db, "interaction-1");
      expect(pending).toMatchObject({
        profile_id: "profile-1",
        task_run_id: runId,
        protocol_request_id: "rpc-1",
        kind: "form",
        state: "pending",
      });
      expect(pending.request_schema_json).not.toContain(sentinel);
      expect(pending.request_schema_json).not.toContain(rawSessionId);

      const delivered = await handle.sendAcpInteractionResponse({
        interactionId: "interaction-1",
        disposition: "accept",
        response: { action: "accept", content: { answer: "do-not-persist" } },
      });
      expect(delivered.ok).toBe(true);
      const submitted = db.prepare("SELECT * FROM acp_interactions WHERE id = ?").get("interaction-1");
      expect(submitted).toMatchObject({ state: "submitted", disposition: "accept" });
      expect(submitted.resolved_at).toEqual(expect.any(Number));
      expect(JSON.stringify(submitted)).not.toContain("do-not-persist");

      await handle.done;
      const log = db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(runId);
      expect(log.events).not.toMatch(/do-not-persist|task-run-request-secret-sentinel|RAW_REMOTE_SESSION/u);
      const run = db.prepare("SELECT diagnostics_json, raw_output_path FROM task_runs WHERE id = ?").get(runId);
      expect(run.diagnostics_json).not.toMatch(/do-not-persist|task-run-request-secret-sentinel|RAW_REMOTE_SESSION/u);
      expect(readFileSync(run.raw_output_path, "utf8")).not.toContain(rawSessionId);
      expect(JSON.stringify(broadcasts)).not.toMatch(/do-not-persist|task-run-request-secret-sentinel|RAW_REMOTE_SESSION/u);
      expect(JSON.stringify(db.prepare("SELECT * FROM acp_interactions").all())).not.toContain(rawSessionId);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("redacts raw ACP session ids before every task-run, API, MCP, log, and broadcast sink", async () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-event-boundary-"));
    try {
      const { taskId, runId } = seed(db);
      const rawSessionId = "RAW_REMOTE_SESSION_ALPHA";
      const malformedProviderId = "RAW_PROVIDER_SESSION_BETA";
      const providerSessionId = `acp:v1:profile-1:${Buffer.from(rawSessionId).toString("base64url")}`;
      const script = {
        events: [
          {
            type: "sdk_event",
            message: `same-event ${rawSessionId}`,
            event: {
              type: "assistant",
              message: { content: [{ type: "text", text: `first ${rawSessionId}` }] },
              metadata: {
                [`key-${rawSessionId}`]: `value ${rawSessionId}`,
                sessionId: rawSessionId,
              },
            },
          },
          {
            type: "runtime_warning",
            warning_kind: "provider_note",
            message: `warning ${rawSessionId} ${malformedProviderId}`,
            diagnostics: {
              note: `diagnostic ${rawSessionId} ${malformedProviderId}`,
              provider_session_id: malformedProviderId,
            },
          },
          {
            type: "sdk_event",
            event: {
              type: "assistant",
              message: { content: [{ type: "text", text: `later ${malformedProviderId}` }] },
            },
          },
          {
            type: "error",
            message: `terminal ${rawSessionId} ${malformedProviderId}`,
            failureKind: "provider_unavailable",
            provider_session_id: providerSessionId,
            diagnostics: {
              provider_session_id: providerSessionId,
              note: `terminal diagnostic ${rawSessionId}`,
              nested: { session_id: malformedProviderId },
            },
            details: {
              provider_session_id: malformedProviderId,
              sessionId: rawSessionId,
              note: `terminal details ${malformedProviderId}`,
            },
          },
        ],
        exitCode: 1,
      };
      const broadcasts = [];
      const loggerEvents = [];
      const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [
        level,
        (...args) => loggerEvents.push({ level, args }),
      ]));
      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "external"],
        env: {
          FAKE_WORKER_SCRIPT: JSON.stringify(script),
          WORKLAB_RUN_ID: runId,
          WORKLAB_DATA_DIR: dataDir,
          WORKLAB_ACP_PROFILE_ID: "profile-1",
        },
        runId,
        taskId,
        broker: {
          broadcast: (channel, event) => broadcasts.push({ channel, event }),
          subscribe: () => {},
          unsubscribe: () => {},
          size: () => 0,
        },
        db,
        logger,
        runIdleWarningMs: 0,
      });

      const result = await handle.done;
      const run = db.prepare(`
        SELECT error_text, warnings_json, diagnostics_json, provider_session_id,
               result_json, transcript_tail_json, raw_output_path
        FROM task_runs WHERE id = ?
      `).get(runId);
      const log = db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(runId);
      const rawLog = readFileSync(run.raw_output_path, "utf8");
      const sinkMatrix = JSON.stringify({ result, run, log, rawLog, broadcasts, loggerEvents });

      expect(sinkMatrix).not.toMatch(/RAW_REMOTE_SESSION_ALPHA|RAW_PROVIDER_SESSION_BETA/u);
      expect(sinkMatrix).not.toMatch(/"sessionId"|"session_id"/u);
      expect(result.providerSessionId).toBe(providerSessionId);
      expect(run.provider_session_id).toBe(providerSessionId);
      expect(JSON.parse(run.diagnostics_json).provider_session_id).toBe(providerSessionId);
      expect(JSON.parse(run.warnings_json)).toContainEqual(expect.objectContaining({
        kind: "provider_note",
        message: "warning [redacted] [redacted]",
      }));
      expect(rawLog).toContain(providerSessionId);

      const watcher = {
        getRunLiveInputState: () => ({ supported: true, active: false }),
      };
      const { app } = createServer({
        db,
        dataDir,
        watcher,
        acpOperationManager: {},
      });
      const api = sameOriginTestAgent(app);
      const apiRun = await api.get(`/api/runs/${runId}`).expect(200);
      const apiRawLog = await api.get(`/api/runs/${runId}/raw-log`).expect(200);
      expect(JSON.stringify(apiRun.body)).not.toMatch(/RAW_REMOTE_SESSION_ALPHA|RAW_PROVIDER_SESSION_BETA/u);
      expect(apiRawLog.text).not.toMatch(/RAW_REMOTE_SESSION_ALPHA|RAW_PROVIDER_SESSION_BETA/u);
      expect(apiRun.body.run.provider_session_id).toBe(providerSessionId);

      const adminHandlers = createAdminToolHandlers({
        baseUrl: "http://worklab.test",
        fetchImpl: async (url) => {
          const target = new URL(url);
          const response = await api.get(`${target.pathname}${target.search}`);
          return new Response(response.text, {
            status: response.status,
            headers: { "content-type": response.headers["content-type"] || "application/json" },
          });
        },
      });
      const mcpRun = await adminHandlers.worklab_run_get({ id: runId });
      expect(JSON.stringify(mcpRun)).not.toMatch(/RAW_REMOTE_SESSION_ALPHA|RAW_PROVIDER_SESSION_BETA/u);
      expect(mcpRun.run.provider_session_id).toBe(providerSessionId);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails the ACP run closed after an event exceeds the privacy traversal budget", async () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-event-budget-"));
    try {
      const { taskId, runId } = seed(db);
      const rawSessionId = "RAW_TOO_DEEP_SESSION";
      const providerSessionId = `acp:v1:profile-1:${Buffer.from(rawSessionId).toString("base64url")}`;
      let nested = { sessionId: rawSessionId };
      for (let depth = 0; depth < 25; depth += 1) nested = { nested };
      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "external"],
        env: {
          FAKE_WORKER_SCRIPT: JSON.stringify({
            events: [
              { type: "sdk_event", text: rawSessionId, nested },
              { type: "final", text: rawSessionId, provider_session_id: providerSessionId },
            ],
          }),
          WORKLAB_RUN_ID: runId,
          WORKLAB_DATA_DIR: dataDir,
          WORKLAB_ACP_PROFILE_ID: "profile-1",
        },
        runId,
        taskId,
        broker: broker(),
        db,
        runIdleWarningMs: 0,
      });

      const result = await handle.done;
      const run = db.prepare(`
        SELECT process_status, failure_kind, error_text, diagnostics_json,
               provider_session_id, raw_output_path
        FROM task_runs WHERE id = ?
      `).get(runId);
      const log = db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(runId);
      const persisted = JSON.stringify({ run, log, rawLog: readFileSync(run.raw_output_path, "utf8") });

      expect(result.processStatus).toBe("failed");
      expect(result.failureKind).toBe("invalid_result");
      expect(result.providerSessionId).toBeNull();
      expect(run.provider_session_id).toBeNull();
      expect(JSON.parse(run.diagnostics_json)).toMatchObject({ acp_event_redaction_failed: true });
      expect(persisted).not.toContain(rawSessionId);
      expect(persisted).not.toContain(providerSessionId);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("expires unanswered requests when the worker exits", async () => {
    const db = makeTestDb();
    try {
      const { taskId, runId } = seed(db);
      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "external"],
        env: {
          FAKE_WORKER_SCRIPT: JSON.stringify({ events: [{
            type: "acp_interaction_requested",
            interaction_id: "interaction-2",
            profile_id: "profile-1",
            interaction_kind: "permission",
            request: { options: [{ optionId: "allow", name: "Allow" }] },
          }] }),
          WORKLAB_RUN_ID: runId,
        },
        runId,
        taskId,
        broker: broker(),
        db,
        runIdleWarningMs: 0,
      });
      await handle.done;
      expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?").get("interaction-2"))
        .toEqual({ state: "expired", disposition: "run_ended" });
    } finally {
      db.close();
    }
  });

  it("applies a worker timeout acknowledgement before the run exits", async () => {
    const db = makeTestDb();
    try {
      const { taskId, runId } = seed(db);
      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "external"],
        env: {
          FAKE_WORKER_SCRIPT: JSON.stringify({
            events: [
              {
                type: "acp_interaction_requested",
                interaction_id: "interaction-timeout",
                profile_id: "profile-1",
                interaction_kind: "permission",
                request: { options: [{ optionId: "allow", name: "Allow" }] },
              },
              {
                type: "acp_interaction_acknowledged",
                interaction_id: "interaction-timeout",
                outcome: "expired",
                reason: "worker_timeout",
              },
            ],
            exitAfterMs: 100,
          }),
          WORKLAB_RUN_ID: runId,
        },
        runId,
        taskId,
        broker: broker(),
        db,
        runIdleWarningMs: 0,
      });
      await vi.waitFor(() => {
        expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?")
          .get("interaction-timeout"))
          .toEqual({ state: "expired", disposition: "worker_timeout" });
      });
      await handle.done;
    } finally {
      db.close();
    }
  });

  it("leaves the row pending when stdin delivery fails", async () => {
    const db = makeTestDb();
    try {
      const { runId } = seed(db);
      insertAcpInteractionRequest(db, {
        id: "interaction-retry",
        profileId: "profile-1",
        taskRunId: runId,
        protocolRequestId: "rpc-retry",
        kind: "form",
        requestSchemaJson: "{}",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const controls = createAcpInteractionControls({
        db,
        runId,
        writeControlMessage: async () => { throw new Error("stdin closed with delivery-secret"); },
        emitEvent: () => {},
        idFactory: () => "delivery-retry",
      });

      await expect(controls.respond({
        interactionId: "interaction-retry",
        disposition: "accept",
        response: { action: "accept", content: { password: "private" } },
      })).resolves.toMatchObject({ ok: false, code: "delivery_failed" });
      expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?")
        .get("interaction-retry"))
        .toMatchObject({ state: "pending", disposition: null });
      controls.close();
    } finally {
      db.close();
    }
  });

  it("redacts numeric and boolean private form values from later worker events", async () => {
    const db = makeTestDb();
    try {
      const { runId } = seed(db);
      insertAcpInteractionRequest(db, {
        id: "interaction-scalars",
        profileId: "profile-1",
        taskRunId: runId,
        protocolRequestId: "rpc-scalars",
        kind: "form",
        requestSchemaJson: "{}",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      let controlMessage;
      const controls = createAcpInteractionControls({
        db,
        runId,
        writeControlMessage: async (message) => { controlMessage = message; },
        emitEvent: () => {},
        idFactory: () => "delivery-scalars",
      });

      const delivered = controls.respond({
        interactionId: "interaction-scalars",
        disposition: "accept",
        response: { action: "accept", content: { pin: 654321, remember: false } },
      });
      await vi.waitFor(() => expect(controlMessage?.delivery_id).toBe("delivery-scalars"));
      expect(controls.redactWorkerEvent({ pin: 654321, remember: false, count: 7, ok: true }))
        .toEqual({ pin: "[redacted]", remember: "[redacted]", count: 7, ok: true });
      controls.handleWorkerEvent({
        type: "acp_interaction_acknowledged",
        interaction_id: "interaction-scalars",
        delivery_id: "delivery-scalars",
        outcome: "submitted",
      });
      await expect(delivered).resolves.toMatchObject({ ok: true });
      controls.close();
    } finally {
      db.close();
    }
  });

  it("waits for a matching worker ack and rejects unoffered permission ids", async () => {
    const db = makeTestDb();
    try {
      const { runId } = seed(db);
      insertAcpInteractionRequest(db, {
        id: "interaction-permission",
        profileId: "profile-1",
        taskRunId: runId,
        protocolRequestId: "rpc-permission",
        kind: "permission",
        requestSchemaJson: JSON.stringify({
          options: [{ optionId: "allow-exact", name: "Allow" }],
        }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      let controlMessage;
      const emitted = [];
      const controls = createAcpInteractionControls({
        db,
        runId,
        writeControlMessage: async (message) => { controlMessage = message; },
        emitEvent: (event) => emitted.push(event),
        idFactory: () => "delivery-permission",
      });

      await expect(controls.respond({
        interactionId: "interaction-permission",
        disposition: "selected",
        response: { outcome: { outcome: "selected", optionId: "invented" } },
      })).resolves.toMatchObject({ ok: false, code: "invalid_response" });
      expect(controlMessage).toBeUndefined();

      const delivered = controls.respond({
        interactionId: "interaction-permission",
        disposition: "selected",
        response: {
          outcome: { outcome: "selected", optionId: "allow-exact" },
          content: { password: "ack-only-secret" },
        },
      });
      await vi.waitFor(() => expect(controlMessage?.delivery_id).toBe("delivery-permission"));
      expect(db.prepare("SELECT state FROM acp_interactions WHERE id = ?")
        .get("interaction-permission").state).toBe("pending");
      controls.handleWorkerEvent({
        type: "acp_interaction_acknowledged",
        interaction_id: "interaction-permission",
        delivery_id: controlMessage.delivery_id,
        outcome: "submitted",
      });

      await expect(delivered).resolves.toMatchObject({ ok: true });
      expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?")
        .get("interaction-permission"))
        .toEqual({ state: "submitted", disposition: "selected" });
      expect(JSON.stringify({
        rows: db.prepare("SELECT * FROM acp_interactions").all(),
        emitted,
      })).not.toContain("ack-only-secret");
      controls.close();
    } finally {
      db.close();
    }
  });

  it("blocks retry while an acknowledgement is uncertain and accepts the late ack once", async () => {
    const db = makeTestDb();
    try {
      const { runId } = seed(db);
      insertAcpInteractionRequest(db, {
        id: "interaction-uncertain",
        profileId: "profile-1",
        taskRunId: runId,
        protocolRequestId: "rpc-uncertain",
        kind: "form",
        requestSchemaJson: "{}",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const controlsSeen = [];
      const controls = createAcpInteractionControls({
        db,
        runId,
        writeControlMessage: async (message) => controlsSeen.push(message),
        emitEvent: () => {},
        idFactory: () => "delivery-uncertain",
        ackTimeoutMs: 5,
      });

      await expect(controls.respond({
        interactionId: "interaction-uncertain",
        disposition: "accept",
        response: { action: "accept", content: { answer: "first-private" } },
      })).resolves.toMatchObject({ ok: false, code: "ack_timeout" });
      expect(db.prepare("SELECT state FROM acp_interactions WHERE id = ?")
        .get("interaction-uncertain").state).toBe("pending");

      await expect(controls.respond({
        interactionId: "interaction-uncertain",
        disposition: "accept",
        response: { action: "accept", content: { answer: "retry-private" } },
      })).resolves.toMatchObject({ ok: false, code: "delivery_in_progress" });
      expect(controlsSeen).toHaveLength(1);

      controls.handleWorkerEvent({
        type: "acp_interaction_acknowledged",
        interaction_id: "interaction-uncertain",
        delivery_id: "delivery-uncertain",
        outcome: "submitted",
      });
      expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?")
        .get("interaction-uncertain"))
        .toEqual({ state: "submitted", disposition: "accept" });
      await expect(controls.respond({
        interactionId: "interaction-uncertain",
        disposition: "accept",
        response: { action: "accept" },
      })).resolves.toMatchObject({ ok: false, code: "no_pending_interaction" });
      expect(controlsSeen).toHaveLength(1);
      controls.close();
    } finally {
      db.close();
    }
  });
});
