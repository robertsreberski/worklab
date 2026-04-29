export const FAILURE_KINDS = [
  "spawn",
  "timeout",
  "stall",
  "usage_limit",
  "invalid_result",
  "tool_failure",
  "provider_unavailable",
  "child_failed",
  "budget_exceeded",
  "cancelled_user",
  "cancelled_stale",
  "abandoned",
];

const USAGE_LIMIT_RE = /(rate limit|usage limit|max tokens|max turns|context length|too many tokens)/i;
const PROVIDER_UNAVAILABLE_RE = /(econn|enotfound|etimedout|service unavailable|503|502|gateway|fetch failed|network)/i;
const TOOL_FAILURE_RE = /(tool .* failed|mcp tool|permission denied|EACCES|read-only file system)/i;

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
    if (cancelInitiator === "stale_reconcile" || cancelInitiator === "coordinator_shutdown") {
      return "cancelled_stale";
    }
    return "cancelled_user";
  }
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
