export function formatDuration(ms) {
  if (ms == null) return null;
  const value = Number(ms);
  if (!Number.isFinite(value)) return null;
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatTokens(n) {
  if (n == null) return null;
  const value = Number(n);
  if (!Number.isFinite(value)) return null;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatCost(v) {
  if (v == null) return null;
  const value = Number(v);
  if (!Number.isFinite(value)) return null;
  return `$${value.toFixed(4)}`;
}

export function runDuration(run) {
  if (run?.log?.duration_ms != null) return run.log.duration_ms;
  if (run?.ended_at && run?.started_at) return run.ended_at - run.started_at;
  return null;
}

export function formatMode(mode) {
  if (!mode) return "Run";
  return String(mode).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatRunPhase(run = {}) {
  return formatMode(run?.stage || run?.mode);
}

export function formatRunSummaryTitle(run = {}) {
  return formatRunPhase(run);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function decisionTone(decision) {
  if (decision === "advance" || decision === "approve") return "ok";
  if (decision === "reject" || decision === "block" || decision === "failed" || decision === "error" || decision === "abandoned") return "error";
  return "";
}

function failureDecision(status) {
  if (status === "error") return "failed";
  if (["failed", "cancelled", "abandoned"].includes(status)) return status;
  return "";
}

function cancellationSummary(run = {}) {
  const initiator = cleanText(run?.cancel_initiator);
  const reason = cleanText(run?.cancel_reason);
  if (initiator && reason) return `Run cancelled (${initiator}: ${reason})`;
  if (reason) return `Run cancelled (${reason})`;
  if (initiator) return `Run cancelled (${initiator})`;
  if (run?.failure_kind === "cancelled_signal") return "Run cancelled (signal)";
  if (run?.failure_kind === "cancelled_stale") return "Run cancelled (stale)";
  if (run?.failure_kind === "cancelled") return "Run cancelled (runtime)";
  return "Run cancelled";
}

export function runResultPreview(run = {}) {
  const processStatus = cleanText(run?.process_status) || cleanText(run?.status);
  const failedDecision = failureDecision(processStatus);
  if (failedDecision) {
    const summary = failedDecision === "cancelled"
      ? cancellationSummary(run)
      : cleanText(run?.error_text) || cleanText(run?.failure_kind) || "Run failed";
    return {
      decision: failedDecision,
      summary,
      details: "",
      tone: decisionTone(failedDecision),
      hasResult: true,
    };
  }

  const result = run?.result || {};
  const decision = cleanText(result.decision) || cleanText(run?.decision);
  const summary = cleanText(result.summary) || cleanText(run?.summary);
  const detailsRaw = cleanText(result.details) || cleanText(run?.details);
  const details = detailsRaw && detailsRaw !== summary ? detailsRaw : "";
  return {
    decision,
    summary,
    details,
    tone: decisionTone(decision),
    hasResult: Boolean(decision || summary || details),
  };
}

export function runTokenTotal(log = {}) {
  const input = Number(log.input_tokens);
  const output = Number(log.output_tokens);
  const total = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
  return total > 0 ? total : null;
}

export function runMetricItems(run) {
  const log = run?.log || {};
  const cost = run?.cost_usd ?? log.cost_usd;
  return [
    ["Duration", formatDuration(runDuration(run))],
    ["Turns", log.num_turns != null ? `${log.num_turns}` : null],
    ["Tokens", formatTokens(runTokenTotal(log))],
    ["Cost", cost != null ? formatCost(cost) : null],
  ].filter(([, value]) => value);
}
