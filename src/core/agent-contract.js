import { normalizeWorklabResult, validateWorklabResultSemantics } from "./worklab-result/contract.js";

export const RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
];

export const EVENT_KINDS = [
  "assistant",
  "thinking",
  "tool_use",
  "tool_result",
  "tool_update",
  "runtime_warning",
  "runtime_error",
  "progress",
  "final",
  "done",
  "verdict",
  "structured_output",
  "worklab_result_candidate",
  "live_user_message",
  "memory_written",
];

export const PROVIDER_KINDS = [
  "claude",
  "pi",
  "codex",
];

export class RunResultInvalid extends Error {
  constructor(field, reason) {
    super(`worklab_result invalid (${field}): ${reason}`);
    this.name = "RunResultInvalid";
    this.field = field;
    this.reason = reason;
  }
}

function isFiniteOrNull(value) {
  return value === null || value === undefined || (typeof value === "number" && Number.isFinite(value));
}

export function normalizeUsage(raw, providerKind) {
  const source = raw && typeof raw === "object" ? raw : {};
  const inputTokens = numberOrNull(
    source.inputTokens ?? source.input_tokens ?? source.prompt_tokens ?? source.promptTokens,
  );
  const outputTokens = numberOrNull(
    source.outputTokens ?? source.output_tokens ?? source.completion_tokens ?? source.completionTokens,
  );
  const cacheReadTokens = numberOrNull(
    source.cacheReadTokens
      ?? source.cache_read_tokens
      ?? source.cache_read_input_tokens
      ?? source.cachedInputTokens
      ?? source.cached_tokens,
  );
  const cacheWriteTokens = numberOrNull(
    source.cacheWriteTokens
      ?? source.cache_creation_tokens
      ?? source.cache_creation_input_tokens
      ?? source.cacheCreationTokens,
  );
  const totalTokens = numberOrNull(source.totalTokens ?? source.total_tokens);
  const costUsd = numberOrNull(source.costUsd ?? source.cost_usd);
  return {
    provider: providerKind || null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: totalTokens ?? deriveTotal(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
    costUsd,
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function deriveTotal(input, output, cacheRead, cacheWrite) {
  const parts = [input, output, cacheRead, cacheWrite].filter((value) => Number.isFinite(value));
  if (!parts.length) return null;
  return parts.reduce((sum, value) => sum + value, 0);
}

function assertWarnings(warnings) {
  if (!Array.isArray(warnings)) throw new RunResultInvalid("warnings", "must be an array");
  for (const [index, warning] of warnings.entries()) {
    if (!warning || typeof warning !== "object") {
      throw new RunResultInvalid(`warnings[${index}]`, "must be an object");
    }
    if (warning.message !== undefined && typeof warning.message !== "string") {
      throw new RunResultInvalid(`warnings[${index}].message`, "must be a string");
    }
    if (warning.kind !== undefined && typeof warning.kind !== "string") {
      throw new RunResultInvalid(`warnings[${index}].kind`, "must be a string");
    }
    if (warning.source !== undefined && typeof warning.source !== "string") {
      throw new RunResultInvalid(`warnings[${index}].source`, "must be a string");
    }
  }
}

function assertUsage(usage) {
  if (usage === null || usage === undefined) return;
  if (typeof usage !== "object" || Array.isArray(usage)) {
    throw new RunResultInvalid("usage", "must be an object");
  }
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd"]) {
    if (!isFiniteOrNull(usage[key])) throw new RunResultInvalid(`usage.${key}`, "must be a finite number or null");
  }
}

// validateRunResult takes the *full* worker `final` payload and ensures the
// structured worklab_result obeys schema + semantics, plus the optional
// usage / warnings shapes. Any failure raises RunResultInvalid so the worker
// can emit a typed `worklab_result_error` event.
export function validateRunResult(payload) {
  if (!payload || typeof payload !== "object") {
    throw new RunResultInvalid("payload", "missing");
  }
  const worklabResult = payload.worklab_result || payload.worklabResult;
  const normalized = normalizeWorklabResult(worklabResult || {});
  if (!normalized.ok) throw new RunResultInvalid("worklab_result", normalized.error);
  const semantic = validateWorklabResultSemantics({ worklab_result: normalized.result });
  if (!semantic.ok) throw new RunResultInvalid("worklab_result", semantic.error);

  if (payload.warnings !== undefined && payload.warnings !== null) {
    assertWarnings(payload.warnings);
  }
  if (payload.usage !== undefined && payload.usage !== null) {
    assertUsage(payload.usage);
  }
  return normalized.result;
}

// Map a vendor-shaped event into the worklab event vocabulary. Adapters
// already emit objects we want to pass through; this helper is a guard
// against a stray `event.type` that shouldn't reach the wire.
export function isKnownEventKind(kind) {
  return EVENT_KINDS.includes(kind);
}

export function makeRuntimeWarning({ kind = "runtime", source = null, message }) {
  return {
    type: "runtime_warning",
    warning_kind: kind,
    source,
    message: String(message || ""),
    ts: Date.now(),
  };
}

export function makeMcpInitFailedWarning({ server, message }) {
  return makeRuntimeWarning({ kind: "mcp_init_failed", source: "mcp_init", message: `${server}: ${message}` });
}
