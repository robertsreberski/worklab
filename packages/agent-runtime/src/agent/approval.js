// Approval manager: gates individual tool calls behind an optional host
// callback that can approve, deny, or "always approve" (session-scoped
// allowlist). Adapted from zeroclaw's ApprovalManager pattern.
//
// Hosts opt in by passing `onToolApprovalRequest` to createRuntime. When the
// callback is not supplied, the gate falls back to per-tier defaults:
//   low risk    → auto-approve
//   medium risk → auto-approve (no host means "don't pause")
//   high risk   → deny (fail closed)
//
// Risk tiers are configured per tool via `riskTiersByTool`; tools missing from
// the map use `defaultRiskTier` ("medium"). A `Bash` tier of "high" is the
// canonical example.
//
// The manager emits structured events through the supplied `onEvent`:
//   - tool_approval_pending  — before calling the host
//   - tool_approval_granted  — host approved (or session allowlist hit)
//   - tool_approval_denied   — host denied, timed out, or host threw
//
// Approval responses from the host should look like
//   { decision: "approve" | "deny" | "always", reason?: string }
// "always" approves this call and adds the tool to the session allowlist.
// Anything else is treated as `tier === "high" ? deny : approve`.

import { randomUUID } from "node:crypto";

export const APPROVAL_DECISIONS = Object.freeze(["approve", "deny", "always"]);
export const RISK_TIERS = Object.freeze(["low", "medium", "high"]);

const DEFAULT_TIMEOUT_MS = 60_000;

export function createApprovalManager({
  onToolApprovalRequest = null,
  defaultRiskTier = "medium",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onEvent = () => {},
  riskTiersByTool = {},
  alwaysAllowTools = [],
} = {}) {
  const sessionAllowlist = new Set(normaliseList(alwaysAllowTools));
  const normalisedTiersByTool = Object.fromEntries(
    Object.entries(riskTiersByTool || {})
      .filter(([, v]) => RISK_TIERS.includes(v))
      .map(([k, v]) => [String(k), v]),
  );
  const normalisedDefault = RISK_TIERS.includes(defaultRiskTier) ? defaultRiskTier : "medium";
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  function riskTierFor(toolName) {
    return normalisedTiersByTool[toolName] || normalisedDefault;
  }

  function emit(event) {
    try { onEvent(event); } catch { /* host emit errors must not escape */ }
  }

  async function request(toolCall = {}) {
    const toolName = String(toolCall.toolName || toolCall.name || "");
    const toolUseId = toolCall.toolUseId || toolCall.id || null;
    const tier = riskTierFor(toolName);

    if (tier === "low") {
      return { decision: "approve", reason: "low_risk", riskTier: tier };
    }

    if (sessionAllowlist.has(toolName)) {
      return { decision: "approve", reason: "session_allowed", riskTier: tier };
    }

    if (typeof onToolApprovalRequest !== "function") {
      if (tier === "high") {
        emitDenial({ toolName, toolUseId, tier, reason: "no_host_callback_for_high_risk" });
        return { decision: "deny", reason: "no_host_callback_for_high_risk", riskTier: tier };
      }
      return { decision: "approve", reason: "no_host_callback_medium_auto_approve", riskTier: tier };
    }

    const requestId = toolCall.requestId || randomUUID();
    const argumentsSummary = redactSecrets(stringifyShort(toolCall.input || toolCall.arguments || {}));
    const payload = {
      requestId,
      toolName,
      toolUseId,
      argumentsSummary,
      riskTier: tier,
      model: toolCall.model || null,
    };

    emit({ type: "tool_approval_pending", ...payload });

    let response;
    let timedOut = false;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => onToolApprovalRequest(payload)),
        new Promise((_, reject) => setTimeout(() => {
          timedOut = true;
          reject(new Error("approval_timeout"));
        }, timeout).unref?.()),
      ]);
    } catch (err) {
      const reason = timedOut || err?.message === "approval_timeout" ? "approval_timeout" : `host_error:${err?.message || err}`;
      emitDenial({ requestId, toolName, toolUseId, tier, reason });
      return { decision: "deny", reason, requestId, riskTier: tier };
    }

    const normalised = normaliseResponse(response, tier);
    if (normalised.decision === "always") {
      sessionAllowlist.add(toolName);
    }
    if (normalised.decision === "deny") {
      emitDenial({ requestId, toolName, toolUseId, tier, reason: normalised.reason });
    } else {
      emit({
        type: "tool_approval_granted",
        requestId,
        toolName,
        toolUseId,
        decision: normalised.decision,
        reason: normalised.reason,
        riskTier: tier,
      });
    }
    return { ...normalised, requestId, riskTier: tier };
  }

  function emitDenial({ requestId = null, toolName, toolUseId = null, tier, reason }) {
    emit({
      type: "tool_approval_denied",
      requestId,
      toolName,
      toolUseId,
      decision: "deny",
      reason,
      riskTier: tier,
    });
  }

  return {
    request,
    riskTierFor,
    sessionAllowlist: () => new Set(sessionAllowlist),
    isAlwaysAllowed: (toolName) => sessionAllowlist.has(String(toolName)),
  };
}

function normaliseResponse(response, tier) {
  if (!response || typeof response !== "object") {
    const fallback = tier === "high" ? "deny" : "approve";
    return { decision: fallback, reason: "invalid_host_response" };
  }
  const decision = APPROVAL_DECISIONS.includes(response.decision)
    ? response.decision
    : (tier === "high" ? "deny" : "approve");
  return { decision, reason: typeof response.reason === "string" ? response.reason : null };
}

function normaliseList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()))]
    : [];
}

function stringifyShort(value) {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return String(value || "");
  }
}

// Redact obvious secrets in argument summaries before we hand them to the
// host's approval UI. Hosts that need raw arguments should read them from
// their own audit log, not from the approval payload.
function redactSecrets(text) {
  const s = String(text || "");
  return s
    .replace(/\b(?:sk|pk)[-_][A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/("(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*)"[^"]+"/gi, '$1"[REDACTED]"');
}

// Wrap a list of Pi-bridge-style tools so each `execute(toolCallId, params, signal)`
// first checks the approval manager. Denied calls throw with a structured
// message so the agent receives a tool_result.is_error and can adapt.
export function wrapToolsWithApprovalGate(tools, approvalManager, { model = null } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  if (!approvalManager) return list;
  return list.map((tool) => {
    if (!tool || typeof tool.execute !== "function") return tool;
    const originalExecute = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(toolCallId, params, signal) {
        const decision = await approvalManager.request({
          toolName: tool.name,
          toolUseId: toolCallId,
          input: params,
          model,
        });
        if (decision.decision === "deny") {
          throw new Error(`Tool call denied (${decision.reason || "no reason"}): ${tool.name}`);
        }
        return originalExecute(toolCallId, params, signal);
      },
    };
  });
}
