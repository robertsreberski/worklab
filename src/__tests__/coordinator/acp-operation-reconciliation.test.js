import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAcpProfile,
  deleteAcpProfileRecord,
} from "../../core/acp-profiles.js";
import { createAcpOperationManager } from "../../coordinator/acp-operation-manager.js";
import {
  claimAcpInteractionResponse,
  finalizeAcpInteractionResponse,
  insertAcpInteractionRequest,
} from "../../core/db/queries/acp-interactions.js";
import {
  insertAcpOperation,
  markAcpOperationRunning,
  markAcpOperationWaiting,
} from "../../core/db/queries/acp-operations.js";
import { makeTestDb } from "../helpers/test-db.js";

const cleanup = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createProfile(db, cwd, suffix) {
  return createAcpProfile({
    db,
    input: {
      agentName: `orphan-${suffix}`,
      displayName: `Orphan ${suffix}`,
      command: process.execPath,
      cwd,
    },
  });
}

function seedOrphanedOperation(db, profileId, state, index, now) {
  const operationId = `orphan-operation-${index}`;
  insertAcpOperation(db, {
    id: operationId,
    profileId,
    kind: "probe",
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
  });
  if (state === "running" || state === "waiting_for_interaction") {
    markAcpOperationRunning(db, operationId, {
      startedAt: now - 900,
      updatedAt: now - 900,
    });
  }
  if (state === "waiting_for_interaction") {
    markAcpOperationWaiting(db, operationId, { updatedAt: now - 800 });
  }
  insertAcpInteractionRequest(db, {
    id: `orphan-interaction-${index}`,
    profileId,
    operationId,
    protocolRequestId: `request-${index}`,
    kind: "permission",
    requestSchemaJson: "{}",
    createdAt: now - 700,
    updatedAt: now - 700,
  });
  if (state === "waiting_for_interaction") {
    insertAcpInteractionRequest(db, {
      id: `orphan-interaction-${index}-submitted`,
      profileId,
      operationId,
      protocolRequestId: `request-${index}-submitted`,
      kind: "permission",
      requestSchemaJson: "{}",
      createdAt: now - 600,
      updatedAt: now - 600,
    });
    claimAcpInteractionResponse(db, `orphan-interaction-${index}-submitted`, {
      disposition: "selected",
      updatedAt: now - 500,
    });
  }
  return operationId;
}

describe("ACP operation startup reconciliation", () => {
  it("terminalizes crash-orphaned operations, expires interactions, and unblocks controls and deletion", async () => {
    const db = makeTestDb();
    const cwd = mkdtempSync(join(tmpdir(), "worklab-acp-orphan-reconcile-"));
    cleanup.push(cwd);
    const profiles = ["queued", "running", "waiting"].map((suffix) => createProfile(db, cwd, suffix));
    const crashedAt = 10_000;
    const restartedAt = 20_000;
    const states = ["queued", "running", "waiting_for_interaction"];
    const operationIds = states.map((state, index) => (
      seedOrphanedOperation(db, profiles[index].id, state, index, crashedAt)
    ));
    const logger = { warn: vi.fn() };
    const probe = vi.fn(async () => ({ ok: true, status: "ready" }));

    const manager = createAcpOperationManager({
      db,
      broker: { broadcast: vi.fn() },
      controls: { probe },
      logger,
      now: () => restartedAt,
    });

    for (const operationId of operationIds) {
      const operation = db.prepare(`
        SELECT state, error_json, completed_at
        FROM acp_operations
        WHERE id = ?
      `).get(operationId);
      expect(operation).toMatchObject({ state: "failed", completed_at: restartedAt });
      expect(JSON.parse(operation.error_json)).toEqual({
        code: "coordinator_restarted",
        message: "Worklab restarted before the ACP operation completed.",
      });
    }
    const interactions = db.prepare(`
      SELECT state, disposition, resolved_at
      FROM acp_interactions
      ORDER BY id
    `).all();
    expect(interactions).toHaveLength(4);
    expect(interactions).toEqual(Array.from({ length: 4 }, () => ({
      state: "expired",
      disposition: "operation_ended",
      resolved_at: restartedAt,
    })));
    expect(logger.warn).toHaveBeenCalledWith({
      operations: 3,
      expired_interactions: 4,
    }, "reconciled orphaned ACP operations at boot");

    const fresh = manager.start({ profileId: profiles[0].id, kind: "probe" });
    await vi.waitFor(() => expect(manager.get(fresh.id)?.state).toBe("succeeded"));
    expect(probe).toHaveBeenCalledTimes(1);

    expect(manager.isProfileActive(profiles[1].id)).toBe(false);
    expect(deleteAcpProfileRecord({ db, id: profiles[1].id })).toEqual({
      id: profiles[1].id,
      agentName: "orphan-running",
    });
  });

  it("rolls back operation terminalization when interaction expiry fails", () => {
    const db = makeTestDb();
    const cwd = mkdtempSync(join(tmpdir(), "worklab-acp-orphan-atomic-"));
    cleanup.push(cwd);
    const profile = createProfile(db, cwd, "atomic");
    seedOrphanedOperation(db, profile.id, "waiting_for_interaction", "atomic", 10_000);
    db.exec(`
      CREATE TRIGGER reject_orphan_interaction_expiry
      BEFORE UPDATE ON acp_interactions
      WHEN OLD.id = 'orphan-interaction-atomic'
      BEGIN
        SELECT RAISE(ABORT, 'forced interaction expiry failure');
      END;
    `);

    expect(() => createAcpOperationManager({
      db,
      controls: { probe: async () => ({ ok: true }) },
      now: () => 20_000,
    })).toThrowError("forced interaction expiry failure");

    expect(db.prepare(`
      SELECT state, completed_at
      FROM acp_operations
      WHERE id = 'orphan-operation-atomic'
    `).get()).toEqual({ state: "waiting_for_interaction", completed_at: null });
    expect(db.prepare(`
      SELECT state, disposition, resolved_at
      FROM acp_interactions
      WHERE id = 'orphan-interaction-atomic'
    `).get()).toEqual({ state: "pending", disposition: null, resolved_at: null });
  });

  it("expires unresolved interactions left behind after an operation was already terminalized", () => {
    const db = makeTestDb();
    const cwd = mkdtempSync(join(tmpdir(), "worklab-acp-terminal-interaction-"));
    cleanup.push(cwd);
    const profile = createProfile(db, cwd, "terminal");
    const operationId = seedOrphanedOperation(db, profile.id, "running", "terminal", 10_000);
    db.prepare(`
      UPDATE acp_operations
      SET state = 'failed', error_json = '{"code":"existing_failure"}', completed_at = 11000
      WHERE id = ?
    `).run(operationId);
    insertAcpInteractionRequest(db, {
      id: "terminal-submitted-unresolved",
      profileId: profile.id,
      operationId,
      protocolRequestId: "terminal-submitted-unresolved",
      kind: "form",
      requestSchemaJson: "{}",
      createdAt: 10_100,
      updatedAt: 10_100,
    });
    claimAcpInteractionResponse(db, "terminal-submitted-unresolved", {
      disposition: "accept",
      updatedAt: 10_200,
    });
    insertAcpInteractionRequest(db, {
      id: "terminal-submitted-resolved",
      profileId: profile.id,
      operationId,
      protocolRequestId: "terminal-submitted-resolved",
      kind: "form",
      requestSchemaJson: "{}",
      createdAt: 10_100,
      updatedAt: 10_100,
    });
    claimAcpInteractionResponse(db, "terminal-submitted-resolved", {
      disposition: "accept",
      updatedAt: 10_200,
    });
    finalizeAcpInteractionResponse(db, "terminal-submitted-resolved", { resolvedAt: 10_300 });

    createAcpOperationManager({ db, controls: {}, now: () => 20_000 });

    expect(db.prepare("SELECT state, error_json, completed_at FROM acp_operations WHERE id = ?")
      .get(operationId)).toEqual({
      state: "failed",
      error_json: '{"code":"existing_failure"}',
      completed_at: 11_000,
    });
    expect(db.prepare(`
      SELECT id, state, disposition, resolved_at
      FROM acp_interactions
      WHERE operation_id = ?
      ORDER BY id
    `).all(operationId)).toEqual([
      {
        id: "orphan-interaction-terminal",
        state: "expired",
        disposition: "operation_ended",
        resolved_at: 20_000,
      },
      {
        id: "terminal-submitted-resolved",
        state: "submitted",
        disposition: "accept",
        resolved_at: 10_300,
      },
      {
        id: "terminal-submitted-unresolved",
        state: "expired",
        disposition: "operation_ended",
        resolved_at: 20_000,
      },
    ]);
  });
});
