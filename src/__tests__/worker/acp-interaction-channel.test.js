import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  createAcpInteractionChannel,
  createAcpPrivateOutputRedactor,
} from "../../worker/acp-interaction-channel.js";
import { ACP_PRIVATE_VALUE_LIMITS } from "../../core/acp-private-values.js";

describe("createAcpInteractionChannel", () => {
  it("round-trips an offered permission option and strips raw tool data", async () => {
    const emit = vi.fn();
    const channel = createAcpInteractionChannel({ emit, idFactory: () => "int-1" });
    channel._disableTimeouts();
    const result = channel.request({
      kind: "permission",
      profileId: "profile-1",
      payload: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1", title: "Run command", rawInput: { secret: "no" } },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      },
    }, { requestId: 42 });

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "acp_interaction_requested",
      interaction_id: "int-1",
      protocol_request_id: "42",
      profile_id: "profile-1",
      interaction_kind: "permission",
    }));
    expect(emit.mock.calls[0][0].request.toolCall).not.toHaveProperty("rawInput");
    expect(emit.mock.calls[0][0].request).not.toHaveProperty("sessionId");
    expect(JSON.stringify(emit.mock.calls)).not.toContain("session-1");
    channel.acceptResponse({ interaction_id: "int-1", optionId: "allow-once", action: "selected" });
    await expect(result).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  it("fails closed when a permission option was not offered", async () => {
    const emit = vi.fn();
    const channel = createAcpInteractionChannel({ emit, idFactory: () => "int-2" });
    channel._disableTimeouts();
    const result = channel.request({
      kind: "permission",
      profileId: "profile-1",
      payload: { options: [{ optionId: "deny", name: "Deny" }] },
    });
    channel.acceptResponse({
      interaction_id: "int-2",
      delivery_id: "delivery-int-2",
      disposition: "selected",
      optionId: "invented",
      action: "selected",
    });
    await expect(result).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "acp_interaction_acknowledged",
      delivery_id: "delivery-int-2",
      outcome: "cancelled",
      disposition: "cancel",
      reason: "response_rejected",
    }));
  });

  it("keeps accepted form content off emitted events", async () => {
    const emit = vi.fn();
    const channel = createAcpInteractionChannel({ emit, idFactory: () => "int-3" });
    channel._disableTimeouts();
    const result = channel.request({
      kind: "elicitation",
      profileId: "profile-1",
      payload: {
        mode: "form",
        message: "Choose a value",
        requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
      },
    });
    channel.acceptResponse({
      interaction_id: "int-3",
      delivery_id: "delivery-int-3",
      disposition: "accept",
      response: { disposition: "accepted", values: { answer: "private" } },
    });
    await expect(result).resolves.toEqual({ action: "accept", content: { answer: "private" } });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "acp_interaction_acknowledged",
      outcome: "submitted",
      disposition: "accept",
    }));
  });

  it("applies the durable interaction sanitizer before emitting schemas", () => {
    const emit = vi.fn();
    const emitPrivateUrlHandoff = vi.fn(() => true);
    const sentinel = "task-run-schema-secret-sentinel";
    const pathSecret = "TASK_PATH_SECRET";
    const querySecret = "TASK_QUERY_SECRET";
    const fragmentSecret = "TASK_FRAGMENT_SECRET";
    const rawUrl = `https://host-secret.example/${pathSecret}?token=${querySecret}#${fragmentSecret}`;
    const channel = createAcpInteractionChannel({
      emit,
      emitPrivateUrlHandoff,
      runId: "run-safe",
      idFactory: () => "int-safe",
    });
    channel._disableTimeouts();
    channel.request({
      kind: "elicitation",
      profileId: "profile-1",
      payload: {
        sessionId: "RAW_REMOTE_FORM_SESSION",
        mode: "url",
        url: rawUrl,
        message: `Open ${rawUrl}`,
        description: `${pathSecret} ${querySecret} ${fragmentSecret} USERINFO_SECRET`,
        requestedSchema: {
          type: "object",
          default: sentinel,
          examples: [sentinel],
          content: { private: sentinel },
          properties: {
            password: {
              type: "string",
              default: sentinel,
              authorization: sentinel,
            },
            answer: { type: "string", default: sentinel },
            content: { type: "string", examples: [sentinel] },
          },
        },
      },
    });

    const emitted = emit.mock.calls[0][0];
    expect(JSON.stringify(emitted)).not.toContain(sentinel);
    expect(JSON.stringify(emitted)).not.toContain("RAW_REMOTE_FORM_SESSION");
    expect(emitted.request).toEqual({
      mode: "url",
      message: "Continue in your browser.",
      urlAvailable: true,
    });
    expect(emitPrivateUrlHandoff).toHaveBeenCalledWith({
      type: "worklab_acp_url_handoff",
      version: 1,
      interaction_id: "int-safe",
      run_id: "run-safe",
      profile_id: "profile-1",
      url: rawUrl,
    });
    expect(JSON.stringify(emit.mock.calls)).not.toMatch(
      /task-run-schema-secret-sentinel|TASK_PATH_SECRET|TASK_QUERY_SECRET|TASK_FRAGMENT_SECRET|USERINFO_SECRET|host-secret/u,
    );
  });

  it("redacts SDK stderr before the private fd handoff callback can settle", () => {
    const stderr = new PassThrough();
    let output = "";
    stderr.on("data", (chunk) => { output += chunk.toString(); });
    const privateOutput = createAcpPrivateOutputRedactor();
    const restore = privateOutput.protectWritable(stderr);
    const rawUrl = "https://HOST_LABEL_PRIVATE.example/PATH_PRIVATE?QUERY_KEY_PRIVATE=QUERY_PRIVATE#FRAGMENT_KEY_PRIVATE=FRAGMENT_PRIVATE";
    const channel = createAcpInteractionChannel({
      emit: () => {},
      runId: "run-stderr-race",
      idFactory: () => "interaction-stderr-race",
      rememberPrivateValues: privateOutput.remember,
      emitPrivateUrlHandoff: () => {
        // Deliberately model stderr winning the parent-side pipe callback race.
        stderr.write(`SDK diagnostic ${rawUrl} HOST_LABEL_PRIVATE QUERY_PRIVATE FRAGMENT_PRIVATE\n`);
        return true;
      },
    });
    channel._disableTimeouts();

    channel.request({
      kind: "elicitation",
      profileId: "profile-1",
      payload: { mode: "url", url: rawUrl },
    });
    restore();

    expect(output).toContain("[redacted]");
    expect(output).not.toMatch(
      /HOST_LABEL_PRIVATE|PATH_PRIVATE|QUERY_KEY_PRIVATE|QUERY_PRIVATE|FRAGMENT_KEY_PRIVATE|FRAGMENT_PRIVATE/u,
    );
  });

  it("redacts accepted private form values from later worker stderr", async () => {
    const privateOutput = createAcpPrivateOutputRedactor();
    const channel = createAcpInteractionChannel({
      emit: () => {},
      idFactory: () => "interaction-private-response",
      rememberPrivateValues: privateOutput.remember,
    });
    channel._disableTimeouts();
    const response = channel.request({
      kind: "elicitation",
      profileId: "profile-1",
      payload: { mode: "form" },
    });
    channel.acceptResponse({
      interaction_id: "interaction-private-response",
      response: { action: "accept", content: { password: "FORM_RESPONSE_PRIVATE" } },
    });

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { password: "FORM_RESPONSE_PRIVATE" },
    });
    expect(privateOutput.redactText("SDK echoed FORM_RESPONSE_PRIVATE"))
      .toBe("SDK echoed [redacted]");
  });

  it("acknowledges a privacy-limit substitution as the cancellation ACP receives", async () => {
    const emit = vi.fn();
    const privateOutput = createAcpPrivateOutputRedactor();
    const channel = createAcpInteractionChannel({
      emit,
      idFactory: () => "interaction-private-limit",
      rememberPrivateValues: privateOutput.remember,
    });
    channel._disableTimeouts();
    const result = channel.request({
      kind: "elicitation",
      profileId: "profile-1",
      payload: { mode: "form" },
    });

    channel.acceptResponse({
      interaction_id: "interaction-private-limit",
      delivery_id: "delivery-private-limit",
      disposition: "accept",
      response: {
        action: "accept",
        content: "x".repeat(ACP_PRIVATE_VALUE_LIMITS.maxChars + 1),
      },
    });

    await expect(result).resolves.toEqual({ action: "cancel" });
    expect(privateOutput.failedClosed).toBe(true);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "acp_interaction_acknowledged",
      interaction_id: "interaction-private-limit",
      delivery_id: "delivery-private-limit",
      outcome: "cancelled",
      disposition: "cancel",
      reason: "response_rejected",
    }));
  });

  it("rejects credential-bearing URL elicitations without emitting on either channel", async () => {
    const emit = vi.fn();
    const emitPrivateUrlHandoff = vi.fn(() => true);
    const channel = createAcpInteractionChannel({
      emit,
      emitPrivateUrlHandoff,
      runId: "run-credentials",
      idFactory: () => "int-credentials",
    });
    await expect(channel.request({
      kind: "elicitation",
      profileId: "profile-1",
      payload: { mode: "url", url: "https://user:password@example.test/private" },
    })).resolves.toEqual({ action: "cancel" });
    expect(emit).not.toHaveBeenCalled();
    expect(emitPrivateUrlHandoff).not.toHaveBeenCalled();
  });

  it("cancels URL elicitations and all pending requests", async () => {
    const ids = ["int-4", "int-5"];
    const channel = createAcpInteractionChannel({
      emit: () => {},
      emitPrivateUrlHandoff: () => true,
      runId: "run-url",
      idFactory: () => ids.shift(),
    });
    channel._disableTimeouts();
    const url = channel.request({ kind: "elicitation", profileId: "p", payload: { mode: "url", url: "https://example.test" } });
    const permission = channel.request({ kind: "permission", profileId: "p", payload: { options: [] } });
    channel.cancelAllPending();
    await expect(url).resolves.toEqual({ action: "cancel" });
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(channel.pendingCount()).toBe(0);
  });

  it("times out fail-closed", async () => {
    const emit = vi.fn();
    const channel = createAcpInteractionChannel({ emit, timeoutMs: 5, idFactory: () => "int-timeout" });
    await expect(channel.request({ kind: "permission", profileId: "p", payload: { options: [] } }))
      .resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "acp_interaction_acknowledged",
      interaction_id: "int-timeout",
      outcome: "expired",
      reason: "worker_timeout",
    }));
    expect(channel.acceptResponse({
      interaction_id: "int-timeout",
      delivery_id: "late-delivery",
      response: { action: "accept" },
    })).toBe(false);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "acp_interaction_acknowledged",
      delivery_id: "late-delivery",
      outcome: "stale",
    }));
  });

  it("cancels a pending interaction when its ACP request is aborted", async () => {
    const controller = new AbortController();
    const emit = vi.fn();
    const channel = createAcpInteractionChannel({ emit, idFactory: () => "int-abort" });
    channel._disableTimeouts();
    const pending = channel.request(
      { kind: "elicitation", profileId: "p", payload: { mode: "form" } },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(channel.pendingCount()).toBe(0);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "acp_interaction_acknowledged",
      outcome: "cancelled",
      reason: "request_aborted",
    }));
  });
});
