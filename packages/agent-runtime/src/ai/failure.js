export const FAILURE_KINDS = [
  "spawn",
  "timeout",
  "stall",
  "usage_limit",
  "invalid_result",
  "invalid_delegation",
  "tool_failure",
  "provider_unavailable",
  "provider_unavailable_exhausted",
  "child_failed",
  "budget_exceeded",
  "cancelled",
  "cancelled_user",
  "cancelled_stale",
  "cancelled_shutdown",
  "cancelled_signal",
  "abandoned",
  // v33: planner delegated to an agent outside the effective team's roster
  // (lead + members). Replaces the retired delegation_agent_not_allowed kind.
  "delegation_agent_not_in_team",
  "delegation_team_roster_empty",
];

const USAGE_LIMIT_RE = /(rate limit|usage limit|max tokens|max turns|context length|too many tokens)/i;
const PROVIDER_UNAVAILABLE_RE = /(econn|enotfound|etimedout|service unavailable|503|502|gateway|fetch failed|network|websocket)/i;
const TOOL_FAILURE_RE = /(tool .* failed|mcp tool|permission denied|EACCES|read-only file system)/i;
const NON_RETRYABLE_PROVIDER_RE = /(invalid[_ ]request|unknown parameter|invalid api key|incorrect api key|authentication|authorization|not authorized|forbidden|billing|insufficient[_ ]quota|quota exceeded|model[_ ]not[_ ]found|unsupported model|permission denied|bad request|401|403|404)/i;
const RETRYABLE_PROVIDER_RE = /(currently overloaded|server(?:s)? (?:is |are )?overloaded|try again later|retry your request|request id|service unavailable|temporar(?:y|ily)|timed? ?out|stream disconnected|fetch failed|econnreset|econnrefused|eai_again|enotfound|etimedout|network|429|too many requests|500|502|503|504|gateway|internal server error)/i;
export const PROVIDER_ABORT_RE = /\b(?:terminated|aborted before final output|aborted before final|stream aborted|stream was aborted|stream disconnected|websocket (?:error|disconnected|closed)|socket hang up|und_err_socket|econnreset|premature close)\b/i;

function requestIdFromText(text) {
  const match = /\b(?:request[_ -]?id|req[_ -]?id)\s*[:#]?\s*([A-Za-z0-9._:-]{8,})/i.exec(text || "");
  return match?.[1]?.replace(/[.,;:]+$/, "") || null;
}

function retryableProviderSubkind(text) {
  if (/overloaded/i.test(text)) return "overloaded";
  if (/429|too many requests|rate limit/i.test(text)) return "rate_limited";
  if (/timed? ?out|etimedout/i.test(text)) return "timeout";
  if (/stream disconnected|fetch failed|econnreset|econnrefused|eai_again|enotfound|network/i.test(text)) return "network";
  if (/500|502|503|504|service unavailable|gateway|internal server error/i.test(text)) return "server_error";
  if (/retry your request|try again later|request id|processing your request/i.test(text)) return "retryable_request";
  return null;
}

export function retryableProviderFailureInfo({
  errorText = "",
  stderrTail = "",
  failureKind = null,
} = {}) {
  if (failureKind && failureKind !== "provider_unavailable") {
    return { retryable: false, subkind: null, requestId: null };
  }
  const haystack = `${errorText || ""}\n${stderrTail || ""}`.trim();
  if (!haystack) return { retryable: false, subkind: null, requestId: null };
  const requestId = requestIdFromText(haystack);
  if (NON_RETRYABLE_PROVIDER_RE.test(haystack)) {
    return { retryable: false, subkind: "non_retryable", requestId };
  }
  const subkind = (failureKind === "provider_unavailable" && PROVIDER_ABORT_RE.test(haystack))
    ? "terminated"
    : retryableProviderSubkind(haystack);
  return {
    retryable: !!subkind || RETRYABLE_PROVIDER_RE.test(haystack),
    subkind: subkind || (RETRYABLE_PROVIDER_RE.test(haystack) ? "retryable_request" : null),
    requestId,
  };
}

// classifyFailure is the single source of truth for mapping the disparate
// inputs the coordinator sees on a worker exit (process code, signal, error
// text, stderr tail, timeout flag, cancellation flag, mcp init result, parse
// errors) into one of FAILURE_KINDS. Every adapter / spawn-worker / watcher
// path should funnel through this so the values in `task_runs.failure_kind`
// stay coherent.
export function classifyFailure({
  exitCode = null,
  signal = null,
  errorText = "",
  stderrTail = "",
  timedOut = false,
  cancelRequested = false,
  cancelInitiator = null,
  resultParseError = false,
  mcpInitFailed = false,
  budgetExceeded = false,
  childFailed = false,
  hint = null,
} = {}) {
  if (budgetExceeded) return "budget_exceeded";
  if (childFailed) return "child_failed";
  if (resultParseError) return "invalid_result";
  if (timedOut) return "timeout";
  if (cancelRequested) {
    // R5: distinguish a clean coordinator shutdown from a stale-run reconcile.
    // Both the audit and the operator care which one: a coordinator_shutdown
    // means "we asked you to stop", and the work is reconciliation-eligible
    // on the next boot. A stale_reconcile means the run was already orphaned
    // (no live coordinator to ask). Mapping both to cancelled_stale hid the
    // difference and confused the audit-period reports.
    if (cancelInitiator === "coordinator_shutdown") return "cancelled_shutdown";
    if (cancelInitiator === "stale_reconcile") return "cancelled_stale";
    if (cancelInitiator === "worker_signal") return "cancelled_signal";
    if (cancelInitiator === "user" || cancelInitiator === "api_cancel") return "cancelled_user";
    // An in-flight run cancelled by the settings-backed turn guardrail reuses
    // budget_exceeded so dashboards / reports don't have to learn a new label.
    if (cancelInitiator === "budget") return "budget_exceeded";
    return "cancelled";
  }
  if (exitCode === 130 || signal === "SIGTERM" || signal === "SIGINT") return "cancelled_signal";
  if (signal === "SIGKILL" && !exitCode) return "abandoned";

  if (hint && FAILURE_KINDS.includes(hint)) return hint;

  const haystack = `${errorText || ""}\n${stderrTail || ""}`;
  if (USAGE_LIMIT_RE.test(haystack)) return "usage_limit";
  if (TOOL_FAILURE_RE.test(haystack)) return "tool_failure";
  if (PROVIDER_UNAVAILABLE_RE.test(haystack)) return "provider_unavailable";
  if (mcpInitFailed && haystack.toLowerCase().includes("mcp")) return "tool_failure";

  if (exitCode === 0 && !errorText) return null;
  return "spawn";
}

// Bounded ring buffer for stderr tails. CLI providers can produce 100s of MB
// of stderr; we only want the last few KB for diagnostics. Returns a string
// guaranteed to be ≤ `limit` bytes, with a `[truncated …]` marker if anything
// was dropped.
export function createStderrTail({ limit = 8 * 1024 } = {}) {
  let buffer = "";
  let dropped = 0;
  return {
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : chunk?.toString?.() || "";
      if (!text) return;
      if (text.length >= limit) {
        dropped += buffer.length + (text.length - limit);
        buffer = text.slice(text.length - limit);
        return;
      }
      const combined = buffer + text;
      if (combined.length <= limit) {
        buffer = combined;
        return;
      }
      const overflow = combined.length - limit;
      dropped += Math.min(buffer.length, overflow);
      buffer = combined.slice(overflow);
    },
    toString() {
      if (!dropped) return buffer;
      return `[truncated ${dropped} earlier bytes]\n${buffer}`;
    },
    get bytesDropped() {
      return dropped;
    },
  };
}
