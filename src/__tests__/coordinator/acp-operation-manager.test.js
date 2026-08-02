import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcpProfile } from "../../core/acp-profiles.js";
import { createAcpOperationManager } from "../../coordinator/acp-operation-manager.js";
import { getAcpInteractionById } from "../../core/db/queries/acp-interactions.js";
import { makeTestDb } from "../helpers/test-db.js";

const cleanup = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(controls) {
  const db = makeTestDb();
  const cwd = mkdtempSync(join(tmpdir(), "worklab-acp-operation-"));
  cleanup.push(cwd);
  const profile = createAcpProfile({
    db,
    input: {
      agentName: "external",
      displayName: "External",
      command: process.execPath,
      cwd,
      envKeys: ["ACP_API_TOKEN"],
      probeTimeoutMs: 5_000,
    },
  });
  const events = [];
  const broker = { broadcast: (channel, event) => events.push({ channel, event }) };
  const manager = createAcpOperationManager({ db, broker, controls });
  return { db, profile, events, manager };
}

async function waitForOperation(manager, operationId, state) {
  await vi.waitFor(() => {
    expect(manager.get(operationId)?.state).toBe(state);
  }, { timeout: 2_000, interval: 5 });
  return manager.get(operationId);
}

describe("AcpOperationManager", () => {
  it("persists a sanitized probe result and bounded profile health", async () => {
    const { db, profile, events, manager } = setup({
      probe: async () => ({
        ok: true,
        status: "ready",
        protocolVersion: 1,
        accessToken: "probe-secret-token",
        capabilities: { sessions: true, apiKey: "nested-secret" },
      }),
    });
    const queued = manager.start({ profileId: profile.id, kind: "probe" });
    expect(queued.state).toBe("queued");
    const completed = await waitForOperation(manager, queued.id, "succeeded");

    expect(completed.result).toEqual({
      ok: true,
      status: "ready",
      protocolVersion: 1,
      capabilities: { sessions: true },
    });
    expect(JSON.stringify(completed)).not.toContain("probe-secret-token");
    expect(JSON.stringify(completed)).not.toContain("nested-secret");
    const probe = db.prepare(`
      SELECT last_probe_state, last_probe_result_json, last_probe_error_json
      FROM acp_profiles WHERE id = ?
    `).get(profile.id);
    expect(probe.last_probe_state).toBe("succeeded");
    expect(JSON.parse(probe.last_probe_result_json)).toEqual(completed.result);
    expect(JSON.parse(probe.last_probe_error_json)).toEqual({});
    expect(events.some(({ event }) => event.type === "acp_operation_updated" && event.state === "succeeded"))
      .toBe(true);
  });

  it("keeps form answers in memory while persisting only schema and disposition", async () => {
    let deliveredResponse;
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        deliveredResponse = await onInteraction({
          requestId: "auth-form-1",
          kind: "form",
          schema: {
            title: "Sign in",
            properties: {
              password: { type: "string", title: "Password", default: "schema-secret" },
            },
            required: ["password"],
          },
        });
        return { authenticated: true, accessToken: "auth-result-secret" };
      },
    });
    const operation = manager.start({ profileId: profile.id, kind: "authenticate" });
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare(`
        SELECT * FROM acp_interactions WHERE operation_id = ? AND state = 'pending'
      `).get(operation.id);
      expect(interaction).toBeTruthy();
    }, { timeout: 2_000, interval: 5 });

    const response = {
      disposition: "accept",
      values: { password: "actual-form-secret" },
    };
    const receipt = manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      response,
    });
    expect(receipt).toMatchObject({ state: "submitted", disposition: "accept", resolvedAt: expect.any(Number) });
    expect(receipt).not.toHaveProperty("response");
    await waitForOperation(manager, operation.id, "succeeded");

    expect(deliveredResponse).toBe(response);
    const stored = getAcpInteractionById(db, interaction.id);
    expect(stored).toMatchObject({ state: "submitted", disposition: "accept" });
    expect(JSON.parse(stored.request_schema_json)).toEqual({
      title: "Sign in",
      properties: { password: { type: "string", title: "Password" } },
      required: ["password"],
    });
    const persisted = JSON.stringify({
      operation: db.prepare("SELECT * FROM acp_operations WHERE id = ?").get(operation.id),
      interaction: stored,
      profile: db.prepare("SELECT * FROM acp_profiles WHERE id = ?").get(profile.id),
    });
    expect(persisted).not.toMatch(/actual-form-secret|schema-secret|auth-result-secret/u);
  });

  it("cancels active operations and expires unanswered interactions", async () => {
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => onInteraction({
        requestId: "approval-1",
        kind: "permission",
        schema: { options: [{ id: "allow_once", label: "Allow once" }] },
      }),
    });
    const operation = manager.start({ profileId: profile.id, kind: "authenticate" });
    await vi.waitFor(() => {
      expect(db.prepare("SELECT state FROM acp_operations WHERE id = ?").get(operation.id)?.state)
        .toBe("waiting_for_interaction");
    }, { timeout: 2_000, interval: 5 });

    expect(manager.abort(operation.id, "test cancellation")).toBe(true);
    await waitForOperation(manager, operation.id, "cancelled");
    expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE operation_id = ?")
      .get(operation.id)).toMatchObject({ state: "expired", disposition: "operation_ended" });
    expect(manager.abort(operation.id)).toBe(false);
  });

  it("redacts credentials and query values from persisted interaction URLs", async () => {
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => onInteraction({
        requestId: "auth-url-1",
        kind: "url",
        schema: {
          url: "https://user:password@example.test/login?token=one-time-secret&state=sensitive#fragment",
        },
      }),
    });
    const operation = manager.start({ profileId: profile.id, kind: "authenticate" });
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?").get(operation.id);
      expect(interaction).toBeTruthy();
    }, { timeout: 2_000, interval: 5 });

    const persisted = interaction.request_schema_json;
    expect(persisted).toContain("https://example.test/login");
    expect(persisted).not.toMatch(/user|password|one-time-secret|sensitive|fragment/u);
    manager.cancelInteraction({ operationId: operation.id, interactionId: interaction.id });
    await waitForOperation(manager, operation.id, "succeeded");
  });

  it("passes remote session identifiers to delete controls without broad request persistence", async () => {
    let received;
    const { profile, manager } = setup({
      deleteSession: async (context) => {
        received = context.remoteSessionId;
        return { deleted: true, sessionId: context.remoteSessionId, token: "drop-me" };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "delete_session",
      remoteSessionId: "session/one",
    });
    const completed = await waitForOperation(manager, operation.id, "succeeded");
    expect(received).toBe("session/one");
    expect(completed.request).toEqual({ remoteSessionId: "session/one" });
    expect(completed.result).toEqual({ deleted: true, sessionId: "session/one" });
    expect(JSON.stringify(completed)).not.toContain("drop-me");
  });

  it("fails closed when a control is unavailable or another operation is active", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { profile, manager } = setup({ probe: async () => gate });
    let missing;
    try {
      manager.start({ profileId: profile.id, kind: "authenticate" });
    } catch (error) {
      missing = error;
    }
    expect(missing).toMatchObject({ code: "not_configured", status: 501 });

    const first = manager.start({ profileId: profile.id, kind: "probe" });
    let conflict;
    try {
      manager.start({ profileId: profile.id, kind: "probe" });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: "operation_active", status: 409 });
    release({ ok: true });
    await waitForOperation(manager, first.id, "succeeded");
  });
});
