import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { spawnWorker } from "../../coordinator/spawn-worker.js";
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
      const script = {
        events: [{
          type: "acp_interaction_requested",
          interaction_id: "interaction-1",
          protocol_request_id: "rpc-1",
          profile_id: "profile-1",
          interaction_kind: "elicitation",
          request: {
            mode: "form",
            message: "Choose",
            requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
          },
        }],
        exitAfterMs: 250,
      };
      const handle = spawnWorker({
        binary: fakeBinary,
        args: ["--task", taskId, "--mode", "execute", "--agent", "external"],
        env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
        runId,
        taskId,
        broker: broker(),
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
      expect(log.events).not.toContain("do-not-persist");
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
});
