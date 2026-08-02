import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcpProfile } from "../../core/acp-profiles.js";
import { createAcpOperationManager } from "../../coordinator/acp-operation-manager.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import { getAcpInteractionById } from "../../core/db/queries/acp-interactions.js";
import { makeTestDb } from "../helpers/test-db.js";
import {
  ACP_PRIVATE_URL_HANDOFF,
  createAcpUrlHandoffStore,
} from "../../core/acp-url-handoff.js";
import {
  structuralAcpProviderSessionId,
  structuralAcpSessionCursor,
} from "../helpers/acp-tokens.js";

const cleanup = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(controls, {
  probeTimeoutMs = 5_000,
  abortCleanupTimeoutMs,
  urlHandoffTtlMs,
} = {}) {
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
      probeTimeoutMs,
    },
  });
  const events = [];
  const broker = { broadcast: (channel, event) => events.push({ channel, event }) };
  const urlHandoffStore = createAcpUrlHandoffStore({ ttlMs: urlHandoffTtlMs });
  const manager = createAcpOperationManager({
    db,
    broker,
    controls,
    abortCleanupTimeoutMs,
    urlHandoffStore,
  });
  return { db, profile, events, manager, urlHandoffStore };
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
        authRequired: true,
        accessToken: "probe-secret-token",
        capabilities: { sessions: true, apiKey: "nested-secret" },
        authMethods: [
          { id: "browser-login", name: "Browser login", type: "agent", token: "method-secret" },
          { id: "", name: "Invalid" },
        ],
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
      authMethods: [{ id: "browser-login", name: "Browser login", type: "agent" }],
    });
    expect(JSON.stringify(completed)).not.toContain("probe-secret-token");
    expect(JSON.stringify(completed)).not.toContain("nested-secret");
    expect(JSON.stringify(completed)).not.toContain("method-secret");
    expect(completed.result).not.toHaveProperty("authRequired");
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
    const rawSessionId = "RAW_MANAGEMENT_INTERACTION_SESSION";
    let deliveredResponse;
    let selectedMethod;
    const { db, profile, events, manager } = setup({
      authenticate: async ({ authMethodId, onInteraction }) => {
        selectedMethod = authMethodId;
        deliveredResponse = await onInteraction({
          requestId: `auth-form:${rawSessionId}`,
          kind: "form",
          schema: {
            sessionId: rawSessionId,
            title: `Sign in ${rawSessionId}`,
            properties: {
              password: { type: "string", title: "Password", default: "schema-secret" },
            },
            required: ["password"],
          },
        });
        return {
          authenticated: true,
          methodId: authMethodId,
          accessToken: "auth-result-secret",
        };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "browser-login",
    });
    expect(operation.request).toEqual({ authMethodId: "browser-login" });
    expect(JSON.parse(db.prepare("SELECT request_json FROM acp_operations WHERE id = ?")
      .get(operation.id).request_json)).toEqual({ authMethodId: "browser-login" });
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

    expect(selectedMethod).toBe("browser-login");
    expect(deliveredResponse).toEqual({
      action: "accept",
      content: { password: "actual-form-secret" },
    });
    expect(manager.get(operation.id).result).toEqual({
      authenticated: true,
      authMethodId: "browser-login",
    });
    const stored = getAcpInteractionById(db, interaction.id);
    expect(stored).toMatchObject({ state: "submitted", disposition: "accept" });
    expect(stored.protocol_request_id).toMatch(/^acp-request:v1:/u);
    expect(JSON.parse(stored.request_schema_json)).toEqual({
      title: "Sign in [redacted]",
      properties: { password: { type: "string", title: "Password" } },
      required: ["password"],
    });
    const persisted = JSON.stringify({
      operation: db.prepare("SELECT * FROM acp_operations WHERE id = ?").get(operation.id),
      interaction: stored,
      profile: db.prepare("SELECT * FROM acp_profiles WHERE id = ?").get(profile.id),
    });
    expect(persisted).not.toMatch(/actual-form-secret|schema-secret|auth-result-secret|RAW_MANAGEMENT_INTERACTION_SESSION/u);
    expect(JSON.stringify(events)).not.toContain(rawSessionId);
  });

  it("delivers a canonical form response when management uses an alias", async () => {
    let acpReceived;
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        acpReceived = await onInteraction({
          requestId: "canonical-form-alias",
          kind: "form",
          schema: { title: "Confirm account" },
        });
        return { authenticated: true };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "canonical-form-alias",
    });
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?")
        .get(operation.id);
      expect(interaction?.state).toBe("pending");
    });

    const receipt = manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      response: {
        disposition: "accepted",
        values: { confirmation: "confirmed" },
        ignored: "not part of the ACP response",
      },
    });

    expect(receipt).toMatchObject({ state: "submitted", disposition: "accept" });
    expect(getAcpInteractionById(db, interaction.id))
      .toMatchObject({ state: "submitted", disposition: "accept" });
    await waitForOperation(manager, operation.id, "succeeded");
    expect(acpReceived).toEqual({
      action: "accept",
      content: { confirmation: "confirmed" },
    });
  });

  it("rejects contradictory form dispositions while accepting equivalent aliases", async () => {
    let deliveredResponse;
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        deliveredResponse = await onInteraction({
          requestId: "form-disposition-integrity",
          kind: "form",
          schema: { title: "Confirm" },
        });
        return { authenticated: false };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "form-disposition-integrity",
    });
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?")
        .get(operation.id);
      expect(interaction?.state).toBe("pending");
    });

    expect(() => manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      disposition: "cancel",
      response: { action: "accept" },
    })).toThrowError("invalid form interaction disposition");
    expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?").get(interaction.id))
      .toEqual({ state: "pending", disposition: null });
    expect(deliveredResponse).toBeUndefined();

    const receipt = manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      disposition: "cancelled",
      response: { action: "cancel" },
    });
    expect(receipt).toMatchObject({ state: "submitted", disposition: "cancel" });
    await waitForOperation(manager, operation.id, "succeeded");
    expect(deliveredResponse).toEqual({ action: "cancel" });
  });

  it.each([
    ["first then second", ["concurrent-first", "concurrent-second"]],
    ["second then first", ["concurrent-second", "concurrent-first"]],
  ])("keeps concurrent interactions waiting until both settle: %s", async (_label, resolutionOrder) => {
    vi.useFakeTimers();
    let deliveredResponses;
    const { db, profile, events, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        const first = onInteraction({
          requestId: "concurrent-first",
          kind: "form",
          schema: { title: "First concurrent request" },
        });
        const second = onInteraction({
          requestId: "concurrent-second",
          kind: "form",
          schema: { title: "Second concurrent request" },
        });
        deliveredResponses = await Promise.all([first, second]);
        return { authenticated: true };
      },
    }, { probeTimeoutMs: 1_000 });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "concurrent-login",
    });
    await vi.advanceTimersByTimeAsync(0);

    const interactions = db.prepare(`
      SELECT * FROM acp_interactions WHERE operation_id = ? ORDER BY rowid ASC
    `).all(operation.id);
    expect(interactions.map(({ protocol_request_id: id }) => id))
      .toEqual(["concurrent-first", "concurrent-second"]);
    expect(manager.get(operation.id)?.state).toBe("waiting_for_interaction");
    expect(manager.active.get(operation.id)?.pending.size).toBe(2);
    expect(manager.active.get(operation.id)?.deadline).toBeNull();
    const interactionByRequest = new Map(interactions.map((row) => [row.protocol_request_id, row]));
    const runningEvents = () => events.filter(({ event }) => (
      event.type === "acp_operation_updated"
      && event.operation.id === operation.id
      && event.state === "running"
    ));
    expect(runningEvents()).toHaveLength(1);
    expect(events.filter(({ event }) => (
      event.type === "acp_operation_updated"
      && event.operation.id === operation.id
      && event.state === "waiting_for_interaction"
    ))).toHaveLength(1);

    const firstResolved = interactionByRequest.get(resolutionOrder[0]);
    manager.respond({
      operationId: operation.id,
      interactionId: firstResolved.id,
      response: { disposition: "accept", values: { answer: resolutionOrder[0] } },
    });
    expect(manager.get(operation.id)?.state).toBe("waiting_for_interaction");
    expect(manager.active.get(operation.id)?.pending.size).toBe(1);
    expect(manager.active.get(operation.id)?.deadline).toBeNull();
    expect(runningEvents()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.get(operation.id)?.state).toBe("waiting_for_interaction");
    expect(manager.isActive(operation.id)).toBe(true);

    const lastResolved = interactionByRequest.get(resolutionOrder[1]);
    manager.respond({
      operationId: operation.id,
      interactionId: lastResolved.id,
      response: { disposition: "accept", values: { answer: resolutionOrder[1] } },
    });
    expect(manager.get(operation.id)?.state).toBe("running");
    expect(manager.active.get(operation.id)?.pending.size).toBe(0);
    expect(manager.active.get(operation.id)?.deadline).not.toBeNull();
    expect(runningEvents()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get(operation.id)?.state).toBe("succeeded");
    expect(deliveredResponses.map(({ content }) => content.answer))
      .toEqual(["concurrent-first", "concurrent-second"]);
  });

  it("keeps sibling interactions pending after a response error or cancellation", async () => {
    let deliveredResponses;
    const { db, profile, events, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        const first = onInteraction({
          requestId: "permission-first",
          kind: "permission",
          schema: {
            options: [{ optionId: "allow-first", name: "Allow first", kind: "allow_once" }],
          },
        });
        const second = onInteraction({
          requestId: "permission-second",
          kind: "permission",
          schema: {
            options: [{ optionId: "allow-second", name: "Allow second", kind: "allow_once" }],
          },
        });
        deliveredResponses = await Promise.all([first, second]);
        return { authenticated: true };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "concurrent-permissions",
    });
    let interactions;
    await vi.waitFor(() => {
      interactions = db.prepare(`
        SELECT * FROM acp_interactions WHERE operation_id = ? ORDER BY rowid ASC
      `).all(operation.id);
      expect(interactions).toHaveLength(2);
    });
    const [first, second] = interactions;
    const runningEvents = () => events.filter(({ event }) => (
      event.type === "acp_operation_updated"
      && event.operation.id === operation.id
      && event.state === "running"
    ));

    expect(() => manager.respond({
      operationId: operation.id,
      interactionId: first.id,
      disposition: "selected",
      response: { outcome: { outcome: "selected", optionId: "unoffered" } },
    })).toThrowError("permission response must select an offered option");
    expect(db.prepare("SELECT state FROM acp_interactions WHERE operation_id = ? ORDER BY rowid ASC")
      .all(operation.id)).toEqual([{ state: "pending" }, { state: "pending" }]);
    expect(manager.get(operation.id)?.state).toBe("waiting_for_interaction");
    expect(manager.active.get(operation.id)?.pending.size).toBe(2);
    expect(runningEvents()).toHaveLength(1);

    manager.cancelInteraction({ operationId: operation.id, interactionId: first.id });
    expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?").get(first.id))
      .toEqual({ state: "cancelled", disposition: "cancel" });
    expect(manager.get(operation.id)?.state).toBe("waiting_for_interaction");
    expect(manager.active.get(operation.id)?.pending.size).toBe(1);
    expect(manager.active.get(operation.id)?.deadline).toBeNull();
    expect(runningEvents()).toHaveLength(1);

    manager.respond({
      operationId: operation.id,
      interactionId: second.id,
      disposition: "allow_once",
      response: { outcome: { outcome: "selected", optionId: "allow-second" } },
    });
    const completed = await waitForOperation(manager, operation.id, "succeeded");
    expect(completed.result).toEqual({ authenticated: true });
    expect(deliveredResponses).toEqual([
      { disposition: "cancel" },
      { outcome: { outcome: "selected", optionId: "allow-second" } },
    ]);
    expect(runningEvents()).toHaveLength(2);
  });

  it("redacts private string, numeric, and boolean response echoes from results and later schemas", async () => {
    const privateCode = "OTP-493827";
    const privatePin = 493827;
    const privateApproval = true;
    let firstDelivered;
    let secondDelivered;
    const { db, profile, events, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        firstDelivered = await onInteraction({
          requestId: "private-scalars",
          kind: "form",
          schema: {
            title: "Enter private values",
            properties: {
              code: { type: "string" },
              pin: { type: "number" },
              approved: { type: "boolean" },
            },
          },
        });
        secondDelivered = await onInteraction({
          requestId: `followup:${firstDelivered.content.code}:OTP${firstDelivered.content.pin}END:approved=${firstDelivered.content.approved}-ish`,
          kind: "form",
          schema: {
            title: `Confirm:${firstDelivered.content.code}:OTP${firstDelivered.content.pin}END:approved=${firstDelivered.content.approved}-ish`,
          },
        });
        return {
          authenticated: firstDelivered.content.approved,
          status: `used:${firstDelivered.content.code}:OTP${firstDelivered.content.pin}END:approved=${firstDelivered.content.approved}-ish`,
          warnings: [
            firstDelivered.content.code,
            `OTP${firstDelivered.content.pin}END`,
            `approved=${firstDelivered.content.approved}-ish`,
          ],
        };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "private-form",
    });
    let first;
    await vi.waitFor(() => {
      first = db.prepare(`
        SELECT * FROM acp_interactions WHERE operation_id = ? AND state = 'pending'
      `).get(operation.id);
      expect(first?.protocol_request_id).toBe("private-scalars");
    });

    manager.respond({
      operationId: operation.id,
      interactionId: first.id,
      response: {
        disposition: "accept",
        values: {
          code: privateCode,
          pin: privatePin,
          approved: privateApproval,
        },
      },
    });

    let second;
    await vi.waitFor(() => {
      second = db.prepare(`
        SELECT * FROM acp_interactions
        WHERE operation_id = ? AND state = 'pending' AND id != ?
      `).get(operation.id, first.id);
      expect(second).toBeTruthy();
    });
    expect(second.protocol_request_id).toMatch(/^acp-request:v1:/u);
    expect(JSON.parse(second.request_schema_json)).toEqual({
      title: "Confirm:[redacted]:OTP[redacted]END:approved=[redacted]-ish",
    });
    manager.respond({
      operationId: operation.id,
      interactionId: second.id,
      response: { disposition: "decline" },
    });

    const completed = await waitForOperation(manager, operation.id, "succeeded");
    expect(firstDelivered.content).toEqual({
      code: privateCode,
      pin: privatePin,
      approved: privateApproval,
    });
    expect(secondDelivered).toEqual({ action: "decline" });
    expect(completed.result).toEqual({
      authenticated: "[redacted]",
      status: "used:[redacted]:OTP[redacted]END:approved=[redacted]-ish",
      warnings: ["[redacted]", "OTP[redacted]END", "approved=[redacted]-ish"],
    });
    const stored = db.prepare("SELECT result_json FROM acp_operations WHERE id = ?").get(operation.id);
    expect(JSON.parse(stored.result_json)).toEqual(completed.result);
    const succeeded = events.find(({ event }) => (
      event.type === "acp_operation_updated"
      && event.state === "succeeded"
      && event.operation.id === operation.id
    ));
    expect(succeeded?.event.operation.result).toEqual(completed.result);
    const exposed = JSON.stringify({
      stored,
      interactions: db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?").all(operation.id),
      events,
    });
    expect(exposed).not.toContain(privateCode);
    expect(exposed).not.toContain(String(privatePin));
    expect(exposed).not.toContain(`OTP${privatePin}END`);
    expect(exposed).not.toContain(`approved=${privateApproval}-ish`);
  });

  it("redacts private response echoes from terminal operation errors", async () => {
    const privateCode = "OTP-ERROR-493827";
    const privatePin = 493827;
    const privateApproval = true;
    const echoedCode = `runtime_PIN${privatePin}END_APPROVED${privateApproval}ISH`;
    const { db, profile, events, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        const response = await onInteraction({
          requestId: "private-error",
          kind: "form",
          schema: { title: "Enter error values" },
        });
        throw Object.assign(new Error(`failed ${response.content.code} OTP${response.content.pin}END approved=${response.content.approved}-ish`), {
          code: `runtime_PIN${response.content.pin}END_APPROVED${response.content.approved}ISH`,
          publicMessage: `failed ${response.content.code} OTP${response.content.pin}END approved=${response.content.approved}-ish`,
        });
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "private-error",
    });
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?")
        .get(operation.id);
      expect(interaction?.state).toBe("pending");
    });
    manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      response: {
        disposition: "accept",
        values: { code: privateCode, pin: privatePin, approved: privateApproval },
      },
    });

    const failed = await waitForOperation(manager, operation.id, "failed");
    expect(failed.error).toEqual({
      code: "operation_failed",
      message: "ACP authenticate operation failed.",
    });
    const stored = db.prepare("SELECT error_json FROM acp_operations WHERE id = ?").get(operation.id);
    expect(JSON.parse(stored.error_json)).toEqual(failed.error);
    expect(JSON.stringify({ stored, events })).not.toContain(privateCode);
    expect(JSON.stringify({ stored, events })).not.toContain(String(privatePin));
    expect(JSON.stringify({ stored, events })).not.toContain(echoedCode);
  });

  it("rejects over-complex private responses and keeps terminal output failed closed", async () => {
    let delivered;
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        delivered = await onInteraction({
          requestId: "too-deep-private-response",
          kind: "form",
          schema: { title: "Deep response" },
        });
        return { authenticated: true, status: "safe after cancellation" };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "deep-form",
    });
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?")
        .get(operation.id);
      expect(interaction?.state).toBe("pending");
    });
    let tooDeep = "private-at-depth";
    for (let depth = 0; depth < 12; depth += 1) tooDeep = { nested: tooDeep };

    expect(() => manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      response: { disposition: "accept", values: tooDeep },
    })).toThrowError("ACP interaction response is too deeply nested or complex");
    expect(db.prepare("SELECT state FROM acp_interactions WHERE id = ?").get(interaction.id).state)
      .toBe("pending");
    expect(delivered).toBeUndefined();
    expect(manager.active.get(operation.id)?.privateResponses.failedClosed).toBe(true);

    manager.cancelInteraction({ operationId: operation.id, interactionId: interaction.id });
    const completed = await waitForOperation(manager, operation.id, "succeeded");
    expect(delivered).toEqual({ disposition: "cancel" });
    expect(completed.result).toEqual({ truncated: true });
  });

  it("rejects permission option ids that the ACP agent did not advertise", async () => {
    let delivered;
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        delivered = await onInteraction({
          requestId: "permission-echo",
          kind: "permission",
          schema: {
            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
          },
        });
        return { authenticated: true };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "permission-login",
    });
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?").get(operation.id);
      expect(interaction?.state).toBe("pending");
    });

    expect(() => manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      disposition: "selected",
      response: { outcome: { outcome: "selected", optionId: "hidden-admin-choice" } },
    })).toThrowError("permission response must select an offered option");
    expect(db.prepare("SELECT state FROM acp_interactions WHERE id = ?").get(interaction.id).state)
      .toBe("pending");
    expect(delivered).toBeUndefined();

    expect(() => manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      disposition: "cancel",
      response: { outcome: { outcome: "selected", optionId: "allow-once" } },
    })).toThrowError("cancelled permission responses cannot select an option");
    expect(db.prepare("SELECT state FROM acp_interactions WHERE id = ?").get(interaction.id).state)
      .toBe("pending");

    manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      disposition: "selected",
      response: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
    await waitForOperation(manager, operation.id, "succeeded");
    expect(delivered).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  it("delivers a canonical permission response for a management shortcut", async () => {
    let acpReceived;
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        acpReceived = await onInteraction({
          requestId: "canonical-permission-shortcut",
          kind: "permission",
          schema: {
            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
          },
        });
        return { authenticated: true };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "canonical-permission-shortcut",
    });
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?")
        .get(operation.id);
      expect(interaction?.state).toBe("pending");
    });

    const receipt = manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      response: {
        disposition: "approved",
        option_id: "allow-once",
        ignored: "not part of the ACP response",
      },
    });

    expect(receipt).toMatchObject({ state: "submitted", disposition: "allow_once" });
    expect(getAcpInteractionById(db, interaction.id))
      .toMatchObject({ state: "submitted", disposition: "allow_once" });
    await waitForOperation(manager, operation.id, "succeeded");
    expect(acpReceived).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  it("accepts a permission cancellation without inventing an option selection", async () => {
    let delivered;
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        delivered = await onInteraction({
          requestId: "permission-cancel",
          kind: "permission",
          schema: {
            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
          },
        });
        return { authenticated: false };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "permission-login",
    });
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?").get(operation.id);
      expect(interaction?.state).toBe("pending");
    });

    const result = manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      response: { outcome: { outcome: "cancelled" } },
    });
    expect(result).toMatchObject({ state: "submitted", disposition: "cancel" });
    await waitForOperation(manager, operation.id, "succeeded");
    expect(delivered).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels active operations and expires unanswered interactions", async () => {
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => onInteraction({
        requestId: "approval-1",
        kind: "permission",
        schema: { options: [{ id: "allow_once", label: "Allow once" }] },
      }),
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "permission-login",
    });
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

  it("pauses the operation deadline while authentication waits for a person", async () => {
    vi.useFakeTimers();
    let delivered;
    const { db, profile, manager } = setup({
      authenticate: async ({ onInteraction }) => {
        delivered = await onInteraction({
          requestId: "slow-human-approval",
          kind: "permission",
          schema: { options: [{ id: "allow_once", label: "Allow once", kind: "allow_once" }] },
        });
        return { authenticated: true };
      },
    }, { probeTimeoutMs: 1_000 });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "permission-login",
    });
    await vi.advanceTimersByTimeAsync(0);
    const interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?")
      .get(operation.id);
    expect(interaction?.state).toBe("pending");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.get(operation.id)?.state).toBe("waiting_for_interaction");
    expect(manager.isActive(operation.id)).toBe(true);

    manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      disposition: "allow_once",
      response: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get(operation.id)?.state).toBe("succeeded");
    expect(delivered).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  });

  it("retains an aborted handler and its database guard while cleanup finishes", async () => {
    let beginCleanup;
    let finishCleanup;
    const cleanupStarted = new Promise((resolve) => { beginCleanup = resolve; });
    const cleanupGate = new Promise((resolve) => { finishCleanup = resolve; });
    const { db, profile, manager } = setup({
      probe: async ({ signal }) => {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        beginCleanup();
        await cleanupGate;
        throw signal.reason;
      },
    }, { abortCleanupTimeoutMs: 1_000 });
    const operation = manager.start({ profileId: profile.id, kind: "probe" });
    await vi.waitFor(() => expect(manager.get(operation.id)?.state).toBe("running"));

    expect(manager.abort(operation.id, "test cleanup gate")).toBe(true);
    await cleanupStarted;
    expect(manager.get(operation.id)?.state).toBe("running");
    expect(manager.isActive(operation.id)).toBe(true);
    expect(() => manager.start({ profileId: profile.id, kind: "probe" }))
      .toThrowError("ACP profile already has an active operation");
    let shutdownSettled = false;
    const shutdown = manager.shutdown().then(() => { shutdownSettled = true; });
    const secondProfile = createAcpProfile({
      db,
      input: {
        agentName: "external-after-shutdown",
        displayName: "External after shutdown",
        command: process.execPath,
        cwd: profile.cwd,
      },
    });
    expect(() => manager.start({ profileId: secondProfile.id, kind: "probe" }))
      .toThrowError("ACP operation manager is shutting down");
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    finishCleanup();
    await shutdown;
    expect(manager.get(operation.id)?.state).toBe("cancelled");
    expect(manager.isActive(operation.id)).toBe(false);
    expect(() => manager.start({ profileId: secondProfile.id, kind: "probe" }))
      .toThrowError("ACP operation manager is shutting down");
  });

  it("quarantines a profile after the cleanup ceiling until its handler settles", async () => {
    let finishCleanup;
    let calls = 0;
    const cleanupGate = new Promise((resolve) => { finishCleanup = resolve; });
    const { db, profile, manager } = setup({
      probe: async ({ signal }) => {
        calls += 1;
        if (calls > 1) return { ok: true, status: "ready" };
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        await cleanupGate;
        throw signal.reason;
      },
    }, { abortCleanupTimeoutMs: 20 });
    const operation = manager.start({ profileId: profile.id, kind: "probe" });
    await vi.waitFor(() => expect(manager.get(operation.id)?.state).toBe("running"));
    expect(manager.abort(operation.id, "test cleanup ceiling")).toBe(true);
    await vi.waitFor(() => expect(manager.isActive(operation.id)).toBe(false), {
      timeout: 500,
      interval: 5,
    });
    expect(manager.get(operation.id)?.state).toBe("running");
    expect(manager.isProfileActive(profile.id)).toBe(true);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM acp_operations
      WHERE profile_id = ?
        AND state IN ('queued', 'running', 'waiting_for_interaction')
    `).get(profile.id)?.count).toBe(1);
    let conflict;
    try {
      manager.start({ profileId: profile.id, kind: "probe" });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: "operation_active", status: 409 });

    finishCleanup();
    await waitForOperation(manager, operation.id, "cancelled");
    expect(manager.isProfileActive(profile.id)).toBe(false);

    const replacement = manager.start({ profileId: profile.id, kind: "probe" });
    await waitForOperation(manager, replacement.id, "succeeded");
  });

  it("keeps shutdown bounded without clearing a quarantined database guard", async () => {
    vi.useFakeTimers();
    const { db, profile, manager } = setup({
      probe: async ({ signal }) => {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return new Promise(() => {});
      },
    }, { abortCleanupTimeoutMs: 50 });
    const operation = manager.start({ profileId: profile.id, kind: "probe" });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get(operation.id)?.state).toBe("running");

    let shutdownSettled = false;
    const shutdown = manager.shutdown().then(() => { shutdownSettled = true; });
    await vi.advanceTimersByTimeAsync(49);
    expect(shutdownSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(shutdownSettled).toBe(true);
    expect(manager.isActive(operation.id)).toBe(false);
    expect(manager.isProfileActive(profile.id)).toBe(true);
    expect(db.prepare("SELECT state FROM acp_operations WHERE id = ?").get(operation.id)?.state)
      .toBe("running");
  });

  it("persists deadline expiry as a failure instead of a user cancellation", async () => {
    vi.useFakeTimers();
    const { profile, manager } = setup({
      probe: async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }, { probeTimeoutMs: 1_000 });
    const operation = manager.start({ profileId: profile.id, kind: "probe" });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.get(operation.id)).toMatchObject({
      state: "failed",
      error: { code: "operation_timeout" },
    });
    expect(manager.isActive(operation.id)).toBe(false);
  });

  it("retains URL query state only in the one-use handoff store", async () => {
    const rawUrl = "https://HOST_LABEL_PRIVATE.example:8443/PATH_PRIVATE/login?QUERY_KEY_PRIVATE=QUERY_PRIVATE&KEY_ONLY_PRIVATE#FRAGMENT_KEY_PRIVATE=FRAGMENT_PRIVATE&SECOND_FRAGMENT_PRIVATE=SECOND_PRIVATE";
    const { db, profile, manager, urlHandoffStore, events } = setup({
      authenticate: async ({ onInteraction }) => {
        const request = {
          requestId: "auth-url-1",
          kind: "url",
          schema: {
            mode: "url",
            url: rawUrl,
            message: `Open ${rawUrl}`,
            description: "PATH_PRIVATE QUERY_PRIVATE FRAGMENT_PRIVATE USERINFO_PRIVATE",
          },
        };
        Object.defineProperty(request, ACP_PRIVATE_URL_HANDOFF, {
          value: rawUrl,
          enumerable: false,
        });
        await onInteraction(request);
        return {
          authenticated: true,
          status: `completed ${rawUrl}`,
          warnings: [
            "HOST_LABEL_PRIVATE",
            "8443",
            "PATH_PRIVATE",
            "QUERY_KEY_PRIVATE",
            "KEY_ONLY_PRIVATE",
            "QUERY_PRIVATE",
            "FRAGMENT_PRIVATE",
            "FRAGMENT_KEY_PRIVATE",
            "SECOND_FRAGMENT_PRIVATE",
            "SECOND_PRIVATE",
          ],
        };
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "url-login",
    });
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?").get(operation.id);
      expect(interaction).toBeTruthy();
    }, { timeout: 2_000, interval: 5 });

    const persisted = interaction.request_schema_json;
    expect(JSON.parse(persisted)).toEqual({
      mode: "url",
      message: "Continue in your browser.",
      urlAvailable: true,
    });
    expect(urlHandoffStore.has({
      interactionId: interaction.id,
      ownerKind: "operation",
      ownerId: operation.id,
      profileId: profile.id,
    })).toBe(true);
    expect(JSON.stringify({
      rows: db.prepare("SELECT * FROM acp_interactions").all(),
      events,
    })).not.toMatch(
      /HOST_LABEL_PRIVATE|8443|PATH_PRIVATE|QUERY_KEY_PRIVATE|KEY_ONLY_PRIVATE|QUERY_PRIVATE|FRAGMENT_KEY_PRIVATE|FRAGMENT_PRIVATE|SECOND_FRAGMENT_PRIVATE|SECOND_PRIVATE|USERINFO_PRIVATE/u,
    );
    expect(() => manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      response: { action: "invented" },
    })).toThrow(/invalid url interaction disposition/u);
    expect(urlHandoffStore.has({
      interactionId: interaction.id,
      ownerKind: "operation",
      ownerId: operation.id,
      profileId: profile.id,
    })).toBe(true);
    manager.cancelInteraction({ operationId: operation.id, interactionId: interaction.id });
    expect(urlHandoffStore.size).toBe(0);
    await waitForOperation(manager, operation.id, "succeeded");
    expect(JSON.stringify({
      operation: manager.get(operation.id),
      rows: db.prepare("SELECT * FROM acp_operations").all(),
      events,
    })).not.toMatch(
      /HOST_LABEL_PRIVATE|8443|PATH_PRIVATE|QUERY_KEY_PRIVATE|KEY_ONLY_PRIVATE|QUERY_PRIVATE|FRAGMENT_KEY_PRIVATE|FRAGMENT_PRIVATE|SECOND_FRAGMENT_PRIVATE|SECOND_PRIVATE|USERINFO_PRIVATE/u,
    );
  });

  it("cancels a URL interaction when its private handoff expires", async () => {
    vi.useFakeTimers();
    let response;
    const rawUrl = "https://private-expiry.example/authorize?state=EXPIRING_PRIVATE_STATE";
    const { db, profile, manager, urlHandoffStore } = setup({
      authenticate: async ({ onInteraction }) => {
        const request = { requestId: "expiring-url", kind: "url" };
        Object.defineProperty(request, ACP_PRIVATE_URL_HANDOFF, {
          value: rawUrl,
          enumerable: false,
        });
        response = await onInteraction(request);
        return { authenticated: response?.disposition === "cancel" };
      },
    }, { probeTimeoutMs: 5_000, urlHandoffTtlMs: 100 });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "url-login",
    });
    await vi.advanceTimersByTimeAsync(0);
    const interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?")
      .get(operation.id);
    expect(interaction?.state).toBe("pending");
    expect(urlHandoffStore.size).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(response).toEqual({ disposition: "cancel" });
    expect(urlHandoffStore.size).toBe(0);
    expect(db.prepare("SELECT state, disposition FROM acp_interactions WHERE id = ?")
      .get(interaction.id)).toEqual({ state: "cancelled", disposition: "cancel" });
    expect(manager.get(operation.id)?.state).toBe("succeeded");
  });

  it("round-trips encoded list identifiers to delete controls without persisting raw session ids", async () => {
    const rawSessionIds = ["session/one", "session/two"];
    const rawPageCursor = "opaque/page-2?state=keep+exact==";
    const receivedCursors = [];
    let received;
    const { db, profile, manager } = setup({
      listSessions: async ({ profile: activeProfile, cursor, operation }) => {
        receivedCursors.push({ cursor, request: operation.request });
        const page = cursor ? 1 : 0;
        const rawSessionId = rawSessionIds[page];
        return {
          sessions: [{
            sessionId: rawSessionId,
            providerSessionId: structuralAcpProviderSessionId(activeProfile.id, rawSessionId),
            title: `Listed session ${page + 1}`,
            updatedAt: rawSessionId,
            token: "drop-list-secret",
          }],
          ...(cursor ? {} : { nextCursor: pageCursor }),
        };
      },
      deleteSession: async (context) => {
        received = context.providerSessionId;
        return {
          deleted: true,
          providerSessionId: context.providerSessionId,
          sessionId: rawSessionIds[1],
          status: `deleted ${rawSessionIds[1]}`,
          token: "drop-delete-secret",
        };
      },
    });
    const pageCursor = structuralAcpSessionCursor(profile.id, rawPageCursor);
    const listedOperation = manager.start({ profileId: profile.id, kind: "list_sessions" });
    const listed = await waitForOperation(manager, listedOperation.id, "succeeded");
    const firstPublicId = structuralAcpProviderSessionId(profile.id, rawSessionIds[0]);
    expect(listed.result).toEqual({
      sessions: [{ id: firstPublicId, title: "Listed session 1" }],
      nextCursor: pageCursor,
      truncated: true,
    });

    const secondOperation = manager.start({
      profileId: profile.id,
      kind: "list_sessions",
      cursor: listed.result.nextCursor,
    });
    expect(secondOperation.request).toEqual({ cursor: pageCursor });
    const secondPage = await waitForOperation(manager, secondOperation.id, "succeeded");
    const publicId = structuralAcpProviderSessionId(profile.id, rawSessionIds[1]);
    expect(secondPage.result).toEqual({
      sessions: [{ id: publicId, title: "Listed session 2" }],
      truncated: false,
    });
    expect(receivedCursors).toEqual([
      { cursor: null, request: {} },
      { cursor: pageCursor, request: { cursor: pageCursor } },
    ]);

    const deleteOperation = manager.start({
      profileId: profile.id,
      kind: "delete_session",
      remoteSessionId: secondPage.result.sessions[0].id,
    });
    const deleted = await waitForOperation(manager, deleteOperation.id, "succeeded");
    expect(received).toBe(publicId);
    expect(deleted.request).toEqual({ providerSessionId: publicId });
    expect(deleted.result).toEqual({ deleted: true, id: publicId });
    const persisted = JSON.stringify(db.prepare("SELECT * FROM acp_operations ORDER BY created_at").all());
    expect(persisted).not.toMatch(/session\/(?:one|two)|drop-list-secret|drop-delete-secret/u);
  });

  it("redacts raw continuation cursor copies from returned, persisted, and broadcast results", async () => {
    const rawCursor = "RAW_CURSOR_COPIED_ACROSS_MANAGEMENT";
    const rawSessionId = "remote-session-with-cursor-copy";
    const { db, profile, events, manager } = setup({
      listSessions: async ({ profile: activeProfile }) => ({
        sessions: [{
          providerSessionId: structuralAcpProviderSessionId(activeProfile.id, rawSessionId),
          title: `Continue ${rawCursor}`,
          status: rawCursor,
        }],
        nextCursor: rawCursor,
      }),
    });

    const operation = manager.start({ profileId: profile.id, kind: "list_sessions" });
    const completed = await waitForOperation(manager, operation.id, "succeeded");
    const providerSessionId = structuralAcpProviderSessionId(profile.id, rawSessionId);
    expect(completed.result).toEqual({
      sessions: [{
        id: providerSessionId,
        title: "Continue [redacted]",
      }],
      truncated: true,
    });

    const stored = db.prepare("SELECT result_json FROM acp_operations WHERE id = ?")
      .get(operation.id);
    expect(JSON.parse(stored.result_json)).toEqual(completed.result);
    const succeeded = events.find(({ event }) => (
      event.type === "acp_operation_updated"
      && event.state === "succeeded"
      && event.operation.id === operation.id
    ));
    expect(succeeded?.event.operation.result).toEqual(completed.result);
    expect(JSON.stringify({ completed, stored, events })).not.toContain(rawCursor);
  });

  it("marks locally capped and unusably paginated session results as truncated", async () => {
    const { profile, manager } = setup({
      listSessions: async ({ profile: activeProfile, cursor }) => {
        if (cursor) return { sessions: [], nextCursor: "x".repeat(5_601) };
        return {
          sessions: Array.from({ length: 201 }, (_, index) => {
            const rawSessionId = `remote/${index}`;
            return {
              providerSessionId: structuralAcpProviderSessionId(activeProfile.id, rawSessionId),
              title: `Session ${index}`,
            };
          }),
        };
      },
    });
    const validCursor = structuralAcpSessionCursor(profile.id, "page-2");

    const capped = manager.start({ profileId: profile.id, kind: "list_sessions" });
    const cappedResult = await waitForOperation(manager, capped.id, "succeeded");
    expect(cappedResult.result.sessions).toHaveLength(200);
    expect(cappedResult.result).toMatchObject({ truncated: true });

    const invalidCursor = manager.start({
      profileId: profile.id,
      kind: "list_sessions",
      cursor: validCursor,
    });
    const invalidResult = await waitForOperation(manager, invalidCursor.id, "succeeded");
    expect(invalidResult.result).toEqual({ sessions: [], truncated: true });
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

  it("maps the cross-manager unique-index race to operation_active", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worklab-acp-operation-shared-"));
    cleanup.push(cwd);
    const databasePath = join(cwd, "worklab.db");
    const firstDb = openDb(databasePath);
    const secondDb = openDb(databasePath);
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let firstManager;
    let secondManager;
    try {
      runMigrations(firstDb);
      const profile = createAcpProfile({
        db: firstDb,
        input: {
          agentName: "cross-manager",
          displayName: "Cross manager",
          command: process.execPath,
          cwd,
        },
      });
      firstManager = createAcpOperationManager({
        db: firstDb,
        controls: { probe: async () => firstGate },
      });
      secondManager = createAcpOperationManager({
        db: secondDb,
        controls: { probe: async () => ({ ok: true, status: "ready" }) },
      });

      const first = firstManager.start({ profileId: profile.id, kind: "probe" });
      let conflict;
      try {
        secondManager.start({ profileId: profile.id, kind: "probe" });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toMatchObject({ code: "operation_active", status: 409 });
      expect(secondDb.prepare(`
        SELECT COUNT(*) AS count FROM acp_operations
        WHERE profile_id = ?
          AND state IN ('queued', 'running', 'waiting_for_interaction')
      `).get(profile.id)?.count).toBe(1);

      releaseFirst({ ok: true, status: "ready" });
      await waitForOperation(firstManager, first.id, "succeeded");
      const second = secondManager.start({ profileId: profile.id, kind: "probe" });
      await waitForOperation(secondManager, second.id, "succeeded");
    } finally {
      releaseFirst?.({ ok: true, status: "ready" });
      await Promise.allSettled([
        firstManager?.shutdown(),
        secondManager?.shutdown(),
      ]);
      firstDb.close();
      secondDb.close();
    }
  });

  it("requires a bounded explicit authentication method id", () => {
    const { profile, manager } = setup({ authenticate: async () => ({ authenticated: true }) });
    expect(() => manager.start({ profileId: profile.id, kind: "authenticate" }))
      .toThrowError("authMethodId is required");
    expect(() => manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "x".repeat(501),
    })).toThrowError("authMethodId is invalid");
    expect(() => manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "browser\nlogin",
    })).toThrowError("authMethodId is invalid");
    expect(() => manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: " browser-login ",
    })).toThrowError("authMethodId is invalid");
  });

  it("requires list-session cursors to remain bounded and opaque", () => {
    const { profile, manager } = setup({ listSessions: async () => ({ sessions: [] }) });
    expect(() => manager.start({
      profileId: profile.id,
      kind: "list_sessions",
      cursor: "page-2",
    })).toThrowError("cursor is invalid");
    expect(() => manager.start({
      profileId: profile.id,
      kind: "list_sessions",
      cursor: " page-2",
    })).toThrowError("cursor is invalid");
    expect(() => manager.start({
      profileId: profile.id,
      kind: "list_sessions",
      cursor: "x".repeat(5_601),
    })).toThrowError("cursor is invalid");
    expect(() => manager.start({
      profileId: profile.id,
      kind: "list_sessions",
      cursor: structuralAcpSessionCursor("other-profile", "page-2"),
    })).toThrowError("cursor is invalid");
  });
});
