import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { spawnWorker } from "../../coordinator/spawn-worker.js";
import { createAcpInteractionControls } from "../../coordinator/spawn-worker/acp-interactions.js";
import { insertAcpInteractionRequest } from "../../core/db/queries/acp-interactions.js";
import { makeTestDb } from "../helpers/test-db.js";
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
    try {
      const { taskId, runId } = seed(db);
      const sentinel = "task-run-request-secret-sentinel";
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
            mode: "form",
            message: "Choose",
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
        }],
        exitAfterMs: 250,
      };
      const broadcasts = [];
      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "external"],
        env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
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
      expect(log.events).not.toMatch(/do-not-persist|task-run-request-secret-sentinel/u);
      const run = db.prepare("SELECT diagnostics_json FROM task_runs WHERE id = ?").get(runId);
      expect(run.diagnostics_json).not.toMatch(/do-not-persist|task-run-request-secret-sentinel/u);
      expect(JSON.stringify(broadcasts)).not.toMatch(/do-not-persist|task-run-request-secret-sentinel/u);
    } finally {
      db.close();
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
