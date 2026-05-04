const RESERVED_RUNTIME_IDS = new Set(["openai", "codex", "vercel", "claude-code", "codex-cli"]);
const ACTIVE_RUNTIME_IDS = new Set(["claude", "pi"]);

function requirePart(value, message) {
  if (!value || typeof value !== "string" || value.trim() !== value) {
    throw new Error(message);
  }
  return value;
}

function rejectTierAlias(model) {
  if (["haiku", "sonnet", "opus"].includes(model)) {
    throw new Error("tier aliases are not valid model references; use an exact model id");
  }
}

export function canonicalizeLegacyModelReference(value) {
  if (!value || typeof value !== "string") throw new Error("model reference required");

  if (value.startsWith("openai:")) {
    const model = requirePart(value.slice("openai:".length), "model id required");
    return `pi:openai:${model}`;
  }
  if (value.startsWith("codex:")) {
    const model = requirePart(value.slice("codex:".length), "model id required");
    return `pi:openai-codex:${model}`;
  }
  if (value.startsWith("vercel:")) {
    const rest = value.slice("vercel:".length);
    const i = rest.indexOf(":");
    if (i <= 0 || i === rest.length - 1) {
      throw new Error("invalid vercel model reference; expected vercel:<providerId>:<modelName>");
    }
    const provider = requirePart(rest.slice(0, i), "provider id required");
    const model = requirePart(rest.slice(i + 1), "model name required");
    return `pi:${provider}:${model}`;
  }
  if (value.startsWith("claude-code:")) {
    const model = requirePart(value.slice("claude-code:".length), "model id required");
    return `claude:${model}`;
  }
  return value;
}

export function normalizeRuntimeModelReference(value) {
  return parseRuntimeModelReference(canonicalizeLegacyModelReference(value));
}

export function sdkFromModelReference(value) {
  const parsed = parseRuntimeModelReference(value);
  return parsed.sdk;
}

export function parseRuntimeModelReference(value) {
  if (!value || typeof value !== "string") throw new Error("model reference required");

  if (value.startsWith("pi:")) {
    const rest = value.slice("pi:".length);
    const i = rest.indexOf(":");
    if (i <= 0 || i === rest.length - 1) {
      throw new Error("invalid pi model reference; expected pi:<providerId>:<modelName>");
    }
    const provider = requirePart(rest.slice(0, i), "provider id required");
    const model = requirePart(rest.slice(i + 1), "model id required");
    return { sdk: "pi", provider, model, reference: value };
  }

  const i = value.indexOf(":");
  if (i <= 0 || i === value.length - 1) {
    throw new Error("invalid model reference; expected <sdk>:<modelId>");
  }
  const sdk = value.slice(0, i);
  const model = requirePart(value.slice(i + 1), "model id required");

  if (RESERVED_RUNTIME_IDS.has(sdk)) {
    throw new Error(`reserved runtime id: ${sdk}; use a canonical pi:* or claude:* model reference`);
  }
  if (!ACTIVE_RUNTIME_IDS.has(sdk)) {
    throw new Error(`unknown sdk: ${sdk}`);
  }
  rejectTierAlias(model);
  return { sdk, model, reference: value };
}

export const ACTIVE_RUNTIME_KINDS = [...ACTIVE_RUNTIME_IDS];
export const RESERVED_RUNTIME_KINDS = [...RESERVED_RUNTIME_IDS];

// intelligence-ramp: which model refs can run under which execution_mode.
//   sdk='claude' (any model)              → CLI (claude binary) or SDK (Anthropic)
//   sdk='pi' + provider='openai-codex'    → CLI (codex app-server) or SDK (pi-sdk)
//   sdk='pi' + provider != 'openai-codex' → SDK only (pi-sdk handles vercel-ai,
//                                           openai, custom OpenAI-compatible
//                                           providers; codex app-server can't
//                                           speak those protocols).
const CODEX_PI_PROVIDER = "openai-codex";

// Returns null when the combo is fine; otherwise a short reason string the
// UI / API can show.
export function executionModeIncompatibilityReason(modelRefOrParsed, executionMode) {
  if (!executionMode || executionMode === "sdk") return null;
  if (executionMode !== "cli") return null;
  let parsed;
  try {
    parsed = typeof modelRefOrParsed === "string"
      ? parseRuntimeModelReference(modelRefOrParsed)
      : modelRefOrParsed;
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (parsed.sdk === "claude") return null;
  if (parsed.sdk === "pi" && parsed.provider === CODEX_PI_PROVIDER) return null;
  if (parsed.sdk === "pi") {
    return `Provider \`${parsed.provider}\` only runs under SDK execution mode (codex app-server can only speak the codex protocol).`;
  }
  return `sdk \`${parsed.sdk}\` is not supported under CLI execution mode.`;
}

export function isModelCompatibleWithExecutionMode(modelRefOrParsed, executionMode) {
  return executionModeIncompatibilityReason(modelRefOrParsed, executionMode) === null;
}
