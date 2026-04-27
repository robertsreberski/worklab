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

export function formatRunSummaryTitle(run = {}, startedAtLabel = "") {
  const phase = formatRunPhase(run);
  const when = String(startedAtLabel || "").trim();
  return [phase, when].filter(Boolean).join(" · ");
}

export function runTokenTotal(log = {}) {
  const input = Number(log.input_tokens);
  const output = Number(log.output_tokens);
  const total = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
  return total > 0 ? total : null;
}

export function runMetricItems(run) {
  const log = run?.log || {};
  return [
    ["Duration", formatDuration(runDuration(run))],
    ["Turns", log.num_turns != null ? `${log.num_turns}` : null],
    ["Tokens", formatTokens(runTokenTotal(log))],
    ["Cost", log.cost_usd != null ? formatCost(log.cost_usd) : null],
  ].filter(([, value]) => value);
}
