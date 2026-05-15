import { describe, expect, it, vi } from "vitest";
import {
  createApprovalManager,
  wrapToolsWithApprovalGate,
} from "../../agent/approval.js";

function captureEvents() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

describe("createApprovalManager — risk tiers", () => {
  it("auto-approves low-risk tools without calling the host", async () => {
    const onToolApprovalRequest = vi.fn();
    const mgr = createApprovalManager({
      onToolApprovalRequest,
      riskTiersByTool: { Read: "low" },
    });
    const result = await mgr.request({ toolName: "Read", input: {} });
    expect(result.decision).toBe("approve");
    expect(result.reason).toBe("low_risk");
    expect(onToolApprovalRequest).not.toHaveBeenCalled();
  });

  it("fails closed (deny) when no host callback is set and tier is high", async () => {
    const { events, onEvent } = captureEvents();
    const mgr = createApprovalManager({
      riskTiersByTool: { Bash: "high" },
      onEvent,
    });
    const result = await mgr.request({ toolName: "Bash", input: { command: "rm -rf /" } });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("no_host_callback_for_high_risk");
    expect(events.find((e) => e.type === "tool_approval_denied")).toBeTruthy();
  });

  it("auto-approves medium when no callback is set", async () => {
    const mgr = createApprovalManager({ defaultRiskTier: "medium" });
    const result = await mgr.request({ toolName: "Read", input: {} });
    expect(result.decision).toBe("approve");
    expect(result.reason).toBe("no_host_callback_medium_auto_approve");
  });
});

describe("createApprovalManager — host responses", () => {
  it("emits pending + granted around a host approval", async () => {
    const { events, onEvent } = captureEvents();
    const mgr = createApprovalManager({
      onToolApprovalRequest: async () => ({ decision: "approve", reason: "ok by me" }),
      onEvent,
      defaultRiskTier: "medium",
    });
    const result = await mgr.request({ toolName: "Bash", input: { command: "ls" } });
    expect(result.decision).toBe("approve");
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("tool_approval_pending");
    expect(kinds).toContain("tool_approval_granted");
  });

  it("session-allowlists a tool after 'always' decision", async () => {
    let calls = 0;
    const mgr = createApprovalManager({
      onToolApprovalRequest: async () => {
        calls += 1;
        return { decision: "always" };
      },
      defaultRiskTier: "medium",
    });
    await mgr.request({ toolName: "Bash", input: {} });
    await mgr.request({ toolName: "Bash", input: {} });
    expect(calls).toBe(1);
    expect(mgr.isAlwaysAllowed("Bash")).toBe(true);
  });

  it("alwaysAllowTools at construction skips the host", async () => {
    const host = vi.fn();
    const mgr = createApprovalManager({
      onToolApprovalRequest: host,
      alwaysAllowTools: ["Read"],
      defaultRiskTier: "medium",
    });
    const result = await mgr.request({ toolName: "Read", input: {} });
    expect(result.decision).toBe("approve");
    expect(result.reason).toBe("session_allowed");
    expect(host).not.toHaveBeenCalled();
  });

  it("denies on host throw and falls back to deny on timeout", async () => {
    const mgr = createApprovalManager({
      onToolApprovalRequest: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      timeoutMs: 5,
      defaultRiskTier: "medium",
    });
    const result = await mgr.request({ toolName: "Bash", input: {} });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("approval_timeout");
  });

  it("emits a deny when the host throws", async () => {
    const { events, onEvent } = captureEvents();
    const mgr = createApprovalManager({
      onToolApprovalRequest: async () => { throw new Error("boom"); },
      onEvent,
      defaultRiskTier: "medium",
    });
    const result = await mgr.request({ toolName: "Bash", input: {} });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/host_error/);
    const denied = events.find((e) => e.type === "tool_approval_denied");
    expect(denied).toBeTruthy();
  });
});

describe("createApprovalManager — secret redaction", () => {
  it("redacts api keys and Bearer tokens in argumentsSummary before emitting", async () => {
    const { events, onEvent } = captureEvents();
    const mgr = createApprovalManager({
      onToolApprovalRequest: async () => ({ decision: "approve" }),
      onEvent,
      defaultRiskTier: "medium",
    });
    await mgr.request({
      toolName: "Bash",
      input: {
        headers: { authorization: "Bearer abcdef1234567890" },
        token: "sk-AAAAAAAAAAAAAAAAAA",
      },
    });
    const pending = events.find((e) => e.type === "tool_approval_pending");
    expect(pending).toBeTruthy();
    expect(pending.argumentsSummary).not.toMatch(/abcdef1234567890/);
    expect(pending.argumentsSummary).not.toMatch(/sk-AAAAAAAAAAAAAAAAAA/);
    expect(pending.argumentsSummary).toContain("[REDACTED]");
  });
});

describe("wrapToolsWithApprovalGate", () => {
  it("invokes the original execute when approval is granted", async () => {
    const mgr = createApprovalManager({
      onToolApprovalRequest: async () => ({ decision: "approve" }),
      defaultRiskTier: "medium",
    });
    const exec = vi.fn(async () => "ok");
    const tools = [{ name: "Bash", execute: exec }];
    const [wrapped] = wrapToolsWithApprovalGate(tools, mgr);
    const result = await wrapped.execute("tu-1", { command: "ls" }, undefined);
    expect(result).toBe("ok");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("throws when approval is denied, without invoking the original execute", async () => {
    const mgr = createApprovalManager({
      onToolApprovalRequest: async () => ({ decision: "deny", reason: "nope" }),
      defaultRiskTier: "medium",
    });
    const exec = vi.fn(async () => "ok");
    const tools = [{ name: "Bash", execute: exec }];
    const [wrapped] = wrapToolsWithApprovalGate(tools, mgr);
    await expect(wrapped.execute("tu-1", { command: "ls" }, undefined)).rejects.toThrow(/denied/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("is a pass-through when no approval manager is supplied", () => {
    const tools = [{ name: "Read", execute: () => "x" }];
    const wrapped = wrapToolsWithApprovalGate(tools, null);
    expect(wrapped).toBe(tools);
  });
});
