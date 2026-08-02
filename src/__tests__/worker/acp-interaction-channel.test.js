import { describe, expect, it, vi } from "vitest";
import { createAcpInteractionChannel } from "../../worker/acp-interaction-channel.js";

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
    channel.acceptResponse({ interaction_id: "int-1", optionId: "allow-once", action: "selected" });
    await expect(result).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  it("fails closed when a permission option was not offered", async () => {
    const channel = createAcpInteractionChannel({ emit: () => {}, idFactory: () => "int-2" });
    channel._disableTimeouts();
    const result = channel.request({
      kind: "permission",
      profileId: "profile-1",
      payload: { options: [{ optionId: "deny", name: "Deny" }] },
    });
    channel.acceptResponse({ interaction_id: "int-2", optionId: "invented", action: "selected" });
    await expect(result).resolves.toEqual({ outcome: { outcome: "cancelled" } });
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
    channel.acceptResponse({ interaction_id: "int-3", response: { action: "accept", content: { answer: "private" } } });
    await expect(result).resolves.toEqual({ action: "accept", content: { answer: "private" } });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
  });

  it("cancels URL elicitations and all pending requests", async () => {
    const ids = ["int-4", "int-5"];
    const channel = createAcpInteractionChannel({ emit: () => {}, idFactory: () => ids.shift() });
    channel._disableTimeouts();
    const url = channel.request({ kind: "elicitation", profileId: "p", payload: { mode: "url", url: "https://example.test" } });
    const permission = channel.request({ kind: "permission", profileId: "p", payload: { options: [] } });
    channel.cancelAllPending();
    await expect(url).resolves.toEqual({ action: "cancel" });
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(channel.pendingCount()).toBe(0);
  });

  it("times out fail-closed", async () => {
    const channel = createAcpInteractionChannel({ emit: () => {}, timeoutMs: 5, idFactory: () => "int-timeout" });
    await expect(channel.request({ kind: "permission", profileId: "p", payload: { options: [] } }))
      .resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels a pending interaction when its ACP request is aborted", async () => {
    const controller = new AbortController();
    const channel = createAcpInteractionChannel({ emit: () => {}, idFactory: () => "int-abort" });
    channel._disableTimeouts();
    const pending = channel.request(
      { kind: "elicitation", profileId: "p", payload: { mode: "form" } },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(channel.pendingCount()).toBe(0);
  });
});
