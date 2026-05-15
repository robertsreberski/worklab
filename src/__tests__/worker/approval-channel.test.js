import { describe, expect, it, vi } from "vitest";
import { createApprovalChannel } from "../../worker/approval-channel.js";

describe("createApprovalChannel", () => {
  it("emits approval_requested then resolves on a matching decision", async () => {
    const emit = vi.fn();
    const channel = createApprovalChannel({ emit });
    channel._disableTimeouts();
    const promise = channel.request({
      requestId: "req-1",
      toolName: "Bash",
      argumentsSummary: "ls",
      riskTier: "high",
      model: "claude-sonnet-4-6",
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      type: "approval_requested",
      request_id: "req-1",
      tool_name: "Bash",
      risk_tier: "high",
    });
    channel.acceptDecision({ request_id: "req-1", decision: "approve", reason: "ok" });
    await expect(promise).resolves.toEqual({ decision: "approve", reason: "ok" });
  });

  it("deny + always decisions pass through unchanged", async () => {
    const channel = createApprovalChannel({ emit: () => {} });
    channel._disableTimeouts();
    const denyPromise = channel.request({ requestId: "req-2", toolName: "Bash" });
    channel.acceptDecision({ request_id: "req-2", decision: "deny", reason: "no" });
    await expect(denyPromise).resolves.toEqual({ decision: "deny", reason: "no" });

    const alwaysPromise = channel.request({ requestId: "req-3", toolName: "Read" });
    channel.acceptDecision({ request_id: "req-3", decision: "always" });
    await expect(alwaysPromise).resolves.toEqual({ decision: "always", reason: null });
  });

  it("coerces unknown decisions to deny", async () => {
    const channel = createApprovalChannel({ emit: () => {} });
    channel._disableTimeouts();
    const promise = channel.request({ requestId: "req-4", toolName: "Bash" });
    channel.acceptDecision({ request_id: "req-4", decision: "yolo" });
    await expect(promise).resolves.toEqual({ decision: "deny", reason: null });
  });

  it("auto-denies on timeout", async () => {
    const channel = createApprovalChannel({ emit: () => {}, timeoutMs: 5 });
    const result = await channel.request({ requestId: "req-5", toolName: "Bash" });
    expect(result).toEqual({ decision: "deny", reason: "approval_timeout" });
  });

  it("missing requestId fails closed", async () => {
    const channel = createApprovalChannel({ emit: () => {} });
    const result = await channel.request({ toolName: "Bash" });
    expect(result).toMatchObject({ decision: "deny", reason: "missing_request_id" });
  });

  it("denyAllPending settles every outstanding request", async () => {
    const channel = createApprovalChannel({ emit: () => {} });
    channel._disableTimeouts();
    const a = channel.request({ requestId: "req-a", toolName: "Bash" });
    const b = channel.request({ requestId: "req-b", toolName: "Bash" });
    expect(channel.pendingCount()).toBe(2);
    channel.denyAllPending("test_reason");
    await expect(a).resolves.toEqual({ decision: "deny", reason: "test_reason" });
    await expect(b).resolves.toEqual({ decision: "deny", reason: "test_reason" });
    expect(channel.pendingCount()).toBe(0);
  });

  it("fails closed when emit throws", async () => {
    const channel = createApprovalChannel({
      emit: () => { throw new Error("pipe broken"); },
    });
    channel._disableTimeouts();
    const result = await channel.request({ requestId: "req-x", toolName: "Bash" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/emit_failed/);
  });
});
