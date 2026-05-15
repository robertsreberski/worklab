// Worker-side glue for HITL tool approvals.
//
// The agent runtime calls onToolApprovalRequest(payload) when an in-flight
// tool call needs a human decision. The worker can't decide; it owns no
// UI. So we:
//   1. emit an `approval_requested` event on stdout so the coordinator can
//      persist the request and surface it via SSE,
//   2. park the callback on `pending` keyed by requestId,
//   3. resolve when the coordinator writes an `approval_decision` line to
//      our stdin (`acceptDecision`), or
//   4. auto-deny after timeoutMs.
//
// On worker drain/exit, every pending request is denied so generators
// don't hang.

const DEFAULT_TIMEOUT_MS = 300_000;

export function createApprovalChannel({ emit, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const pending = new Map();
  let timeoutsEnabled = true;

  function settle(requestId, response) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(response);
    return true;
  }

  function request(payload) {
    const requestId = payload?.requestId || payload?.request_id;
    if (!requestId) {
      // Without a request id we can't route the response. Fail closed.
      return Promise.resolve({ decision: "deny", reason: "missing_request_id" });
    }
    return new Promise((resolve) => {
      let timer = null;
      if (timeoutsEnabled && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (pending.delete(requestId)) {
            resolve({ decision: "deny", reason: "approval_timeout" });
          }
        }, timeoutMs);
        if (typeof timer?.unref === "function") timer.unref();
      }
      pending.set(requestId, { resolve, timer });
      try {
        emit({
          type: "approval_requested",
          request_id: requestId,
          tool_name: payload?.toolName || payload?.tool_name || "",
          tool_use_id: payload?.toolUseId || payload?.tool_use_id || null,
          arguments_summary: payload?.argumentsSummary || payload?.arguments_summary || "",
          risk_tier: payload?.riskTier || payload?.risk_tier || "medium",
          model: payload?.model || null,
          ts: Date.now(),
        });
      } catch (err) {
        // Failing to emit means the coordinator will never decide. Fail
        // closed and clean up.
        if (pending.delete(requestId) && timer) clearTimeout(timer);
        resolve({ decision: "deny", reason: `emit_failed:${err?.message || err}` });
      }
    });
  }

  function acceptDecision(message) {
    if (!message || typeof message !== "object") return false;
    const requestId = message.request_id || message.requestId;
    if (!requestId) return false;
    const decision = ["approve", "deny", "always"].includes(message.decision) ? message.decision : "deny";
    return settle(requestId, { decision, reason: message.reason || null });
  }

  function denyAllPending(reason = "worker_terminated") {
    for (const [requestId] of pending) {
      settle(requestId, { decision: "deny", reason });
    }
  }

  return {
    request,
    acceptDecision,
    denyAllPending,
    pendingCount: () => pending.size,
    // Test helper.
    _disableTimeouts() { timeoutsEnabled = false; },
  };
}
