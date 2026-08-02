import { describe, expect, it, vi } from "vitest";

import { createAcpInteractionControls } from "../../coordinator/spawn-worker/acp-interactions.js";
import { ACP_PRIVATE_VALUE_LIMITS } from "../../core/acp-private-values.js";
import { insertAcpInteractionRequest } from "../../core/db/queries/acp-interactions.js";
import { newRunId, newTaskId } from "../../core/ids.js";
import {
  createAcpInteractionChannel,
  createAcpPrivateOutputRedactor,
} from "../../worker/acp-interaction-channel.js";
import { makeTestDb } from "../helpers/test-db.js";

function seedInteraction(db, interactionId, kind = "form") {
  const taskId = newTaskId();
  const runId = newRunId();
  const now = Date.now();
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(taskId, "ACP response privacy", now, now);
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
  insertAcpInteractionRequest(db, {
    id: interactionId,
    profileId: "profile-1",
    taskRunId: runId,
    protocolRequestId: `rpc-${interactionId}`,
    kind,
    requestSchemaJson: kind === "url"
      ? JSON.stringify({ mode: "url", message: "Continue in your browser.", urlAvailable: true })
      : "{}",
    createdAt: now,
    updatedAt: now,
  });
  return { runId };
}

describe("task-run ACP response privacy contract", () => {
  it.each([
    ["character", () => "x".repeat(ACP_PRIVATE_VALUE_LIMITS.maxChars + 1)],
    ["node", () => Array.from({ length: ACP_PRIVATE_VALUE_LIMITS.maxNodes }, () => null)],
    ["private-value", () => Array.from(
      { length: ACP_PRIVATE_VALUE_LIMITS.maxValues + 1 },
      (_, index) => `private-${index}`,
    )],
  ])("rejects a response beyond the worker %s budget before delivery", async (_label, content) => {
    const db = makeTestDb();
    try {
      const interactionId = "interaction-parent-limit";
      const { runId } = seedInteraction(db, interactionId);
      const writeControlMessage = vi.fn();
      const controls = createAcpInteractionControls({
        db,
        runId,
        writeControlMessage,
        emitEvent: () => {},
      });

      await expect(controls.respond({
        interactionId,
        disposition: "accept",
        response: { action: "accept", content: content() },
      })).resolves.toEqual({
        ok: false,
        code: "invalid_response",
        message: "private response exceeds safety limits",
      });
      expect(writeControlMessage).not.toHaveBeenCalled();
      expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?")
        .get(interactionId)).toEqual({ state: "pending", disposition: null });
      controls.close();
    } finally {
      db.close();
    }
  });

  it.each(["form", "url"])(
    "rejects contradictory task %s dispositions and canonicalizes equivalent aliases",
    async (kind) => {
      const db = makeTestDb();
      try {
        const interactionId = `interaction-task-${kind}-disposition`;
        const { runId } = seedInteraction(db, interactionId, kind);
        let controlMessage;
        const controls = createAcpInteractionControls({
          db,
          runId,
          writeControlMessage: async (message) => { controlMessage = message; },
          emitEvent: () => {},
          idFactory: () => "delivery-task-disposition",
        });

        await expect(controls.respond({
          interactionId,
          disposition: "cancel",
          response: { action: "accept" },
        })).resolves.toEqual({
          ok: false,
          code: "invalid_response",
          message: "interaction response disposition is invalid",
        });
        expect(controlMessage).toBeUndefined();

        const delivered = controls.respond({
          interactionId,
          disposition: "cancelled",
          response: { action: "cancel" },
        });
        await vi.waitFor(() => expect(controlMessage?.disposition).toBe("cancel"));
        controls.handleWorkerEvent({
          type: "acp_interaction_acknowledged",
          interaction_id: interactionId,
          delivery_id: "delivery-task-disposition",
          outcome: "submitted",
          disposition: "cancel",
        });

        await expect(delivered).resolves.toMatchObject({ ok: true });
        expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?")
          .get(interactionId)).toEqual({ state: "submitted", disposition: "cancel" });
        controls.close();
      } finally {
        db.close();
      }
    },
  );

  it("persists the worker's fail-closed cancellation instead of the requested accept", async () => {
    const db = makeTestDb();
    try {
      const interactionId = "interaction-worker-limit";
      const { runId } = seedInteraction(db, interactionId);
      const privateOutput = createAcpPrivateOutputRedactor();
      expect(privateOutput.remember("worker-only-budget-prefix")).toBe(true);
      const workerEvents = [];
      const resolvedEvents = [];
      let controls;
      const channel = createAcpInteractionChannel({
        emit: (event) => {
          workerEvents.push(event);
          if (event.type === "acp_interaction_acknowledged") controls.handleWorkerEvent(event);
        },
        idFactory: () => interactionId,
        rememberPrivateValues: privateOutput.remember,
      });
      channel._disableTimeouts();
      controls = createAcpInteractionControls({
        db,
        runId,
        writeControlMessage: async (message) => { channel.acceptResponse(message); },
        emitEvent: (event) => resolvedEvents.push(event),
        idFactory: () => "delivery-worker-limit",
      });
      const acpReceived = channel.request({
        kind: "elicitation",
        profileId: "profile-1",
        payload: { mode: "form" },
      });
      const atWorkerLimit = "x".repeat(ACP_PRIVATE_VALUE_LIMITS.maxChars);

      const delivered = await controls.respond({
        interactionId,
        disposition: "accept",
        response: { action: "accept", content: atWorkerLimit },
      });

      await expect(acpReceived).resolves.toEqual({ action: "cancel" });
      expect(delivered).toMatchObject({ ok: true, row: { state: "cancelled", disposition: "cancel" } });
      expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?")
        .get(interactionId)).toEqual({ state: "cancelled", disposition: "cancel" });
      expect(workerEvents.at(-1)).toMatchObject({
        type: "acp_interaction_acknowledged",
        interaction_id: interactionId,
        delivery_id: "delivery-worker-limit",
        outcome: "cancelled",
        disposition: "cancel",
        reason: "response_rejected",
      });
      expect(resolvedEvents).toContainEqual(expect.objectContaining({
        type: "acp_interaction_resolved",
        state: "cancelled",
        disposition: "cancel",
      }));
      expect(privateOutput.failedClosed).toBe(true);
      controls.close();
    } finally {
      db.close();
    }
  });
});
