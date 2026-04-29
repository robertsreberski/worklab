import { getModel as getPiModel, getModels as getPiModels, supportsXhigh } from "@mariozechner/pi-ai";

export const BUILTIN_CLAUDE_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
];

export const BUILTIN_OPENAI_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
];

export const BUILTIN_CODEX_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
];

export const VALID_MODEL_SDKS = ["claude", "openai", "vercel", "claude-code", "codex", "pi"];
export const WORKLAB_BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"];

const EXTRA_PI_PROVIDER_IDS = [
  "github-copilot",
  "google-gemini-cli",
  "google",
  "deepseek",
  "groq",
  "mistral",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
];

const PI_PROVIDER_LABELS = {
  "github-copilot": "GitHub Copilot",
  "google-gemini-cli": "Gemini CLI",
  google: "Google Gemini",
  deepseek: "DeepSeek",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI",
  openrouter: "OpenRouter",
  "vercel-ai-gateway": "Vercel AI Gateway",
};

const MODEL_SHORT_LABELS = {
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.4-nano": "GPT-5.4 Nano",
};

const CLAUDE_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const OPENAI_REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh"];
const REASONING_EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];

function runtimeMetadata({
  runtimeKind,
  supportsMcp,
  supportsSkills,
  supportsWorklabTools,
  nativeToolsNote,
  mcpMode,
  skillsMode = "prompt-index",
} = {}) {
  return {
    runtime_kind: runtimeKind,
    supports_mcp: !!supportsMcp,
    supports_skills: !!supportsSkills,
    supports_worklab_tools: !!supportsWorklabTools,
    native_tools_note: nativeToolsNote || null,
    mcp_mode: mcpMode || null,
    skills_mode: skillsMode,
  };
}

function claudeReasoningCapabilities(model, runtime = "sdk") {
  const common = {
    tool_use: true,
    vision: true,
    json_mode: true,
    ...runtimeMetadata({
      runtimeKind: runtime,
      supportsMcp: true,
      supportsSkills: true,
      supportsWorklabTools: runtime === "sdk",
      nativeToolsNote: runtime === "cli"
        ? "Claude Code uses native CLI tools; Worklab maps this allowlist to Claude Code tool flags."
        : null,
      mcpMode: runtime === "cli" ? "per-run-json" : "sdk",
    }),
  };
  if (model.includes("haiku")) {
    return {
      ...common,
      reasoning: false,
      reasoning_mode: "none",
    };
  }
  return {
    ...common,
    reasoning: true,
    reasoning_mode: "effort",
    reasoning_levels: model.includes("opus") ? CLAUDE_REASONING_LEVELS : CLAUDE_REASONING_LEVELS.filter((level) => level !== "xhigh"),
    reasoning_disable_supported: true,
  };
}

function openaiReasoningCapabilities(model, runtime = "sdk") {
  const common = {
    tool_use: true,
    vision: true,
    json_mode: true,
    ...runtimeMetadata({
      runtimeKind: runtime,
      supportsMcp: true,
      supportsSkills: true,
      supportsWorklabTools: runtime === "sdk",
      nativeToolsNote: runtime === "cli"
        ? "Codex uses native CLI tools. Worklab can pass MCP config and effort, but Codex does not expose a per-tool built-in allowlist for exec."
        : null,
      mcpMode: runtime === "cli" ? "inline-config" : "sdk",
    }),
  };
  return {
    ...common,
    reasoning: true,
    reasoning_mode: "effort",
    reasoning_levels: OPENAI_REASONING_LEVELS,
    reasoning_disable_supported: true,
  };
}

function piReasoningLevels(model) {
  if (!model?.reasoning) return undefined;
  return ["none", "low", "medium", "high", ...(supportsXhigh(model) ? ["xhigh"] : [])];
}

function piModelCapabilities(model, runtimeKind = "pi-agent") {
  return {
    tool_use: true,
    vision: Array.isArray(model?.input) ? model.input.includes("image") : true,
    json_mode: true,
    reasoning: !!model?.reasoning,
    reasoning_mode: model?.reasoning ? "effort" : "none",
    reasoning_levels: piReasoningLevels(model),
    reasoning_disable_supported: !!model?.reasoning,
    context_window: Number(model?.contextWindow) || undefined,
    max_tokens: Number(model?.maxTokens) || undefined,
    ...runtimeMetadata({
      runtimeKind,
      supportsMcp: true,
      supportsSkills: true,
      supportsWorklabTools: true,
      mcpMode: "sdk",
      skillsMode: "read-skill-tool",
    }),
  };
}

function piModelMetadata(provider, modelId, sdk, { labelPrefix = "", description = null } = {}) {
  let model;
  try {
    model = getPiModel(provider, modelId);
  } catch {
    model = null;
  }
  const label = [labelPrefix, model?.name || MODEL_SHORT_LABELS[modelId] || modelId].filter(Boolean).join(" ");
  return {
    value: `${sdk}:${modelId}`,
    label,
    description: description || model?.name || null,
    sdk,
    model: modelId,
    capabilities: model ? piModelCapabilities(model) : openaiReasoningCapabilities(modelId),
    ...(model?.cost ? { pricing: model.cost } : {}),
  };
}

function piProviderModels(provider) {
  let models = [];
  try {
    models = getPiModels(provider);
  } catch {
    return [];
  }
  return models.map((model) => ({
    value: `pi:${provider}:${model.id}`,
    label: model.name || model.id,
    description: `${PI_PROVIDER_LABELS[provider] || provider} / ${model.id}`,
    sdk: "pi",
    provider,
    model: model.id,
    capabilities: piModelCapabilities(model),
    pricing: model.cost || null,
  }));
}

const BUILTIN_MODEL_GROUPS = [
  {
    id: "claude",
    label: "Claude",
    models: [
      {
        value: "claude:claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        description: "Fast",
        sdk: "claude",
        model: "claude-haiku-4-5-20251001",
        capabilities: claudeReasoningCapabilities("claude-haiku-4-5-20251001"),
      },
      {
        value: "claude:claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "Balanced",
        sdk: "claude",
        model: "claude-sonnet-4-6",
        capabilities: claudeReasoningCapabilities("claude-sonnet-4-6"),
      },
      {
        value: "claude:claude-opus-4-7",
        label: "Claude Opus 4.7",
        description: "Most capable",
        sdk: "claude",
        model: "claude-opus-4-7",
        capabilities: claudeReasoningCapabilities("claude-opus-4-7"),
      },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: BUILTIN_OPENAI_MODELS.map((model) => piModelMetadata("openai", model, "openai", {
      description: model === "gpt-5.5" ? "Flagship" : null,
    })),
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    models: BUILTIN_CODEX_MODELS.map((model) => piModelMetadata("openai-codex", model, "codex", {
      labelPrefix: "Codex",
      description: "ChatGPT OAuth via pi-ai",
    })),
  },
];

function getPiProviderGroups() {
  return EXTRA_PI_PROVIDER_IDS
    .map((provider) => ({
      id: `pi:${provider}`,
      label: PI_PROVIDER_LABELS[provider] || provider,
      sdk: "pi",
      provider,
      models: piProviderModels(provider),
    }))
    .filter((group) => group.models.length > 0);
}

const HIDDEN_LEGACY_MODELS = BUILTIN_CLAUDE_MODELS.map((model) => ({
  value: `claude-code:${model}`,
  label: `Claude Code ${MODEL_SHORT_LABELS[model] || model}`,
  description: "Legacy alias routed through the Claude Agent SDK.",
  sdk: "claude-code",
  model,
  capabilities: claudeReasoningCapabilities(model),
  deprecated: true,
}));

function withBuiltinToolMetadata(model) {
  if (Array.isArray(model?.builtin_tools)) {
    return {
      ...model,
      supports_builtin_tools: model.builtin_tools.length > 0,
    };
  }
  const supportsBuiltinTools = model?.capabilities?.tool_use !== false;
  return {
    ...model,
    builtin_tools: supportsBuiltinTools ? [...WORKLAB_BUILTIN_TOOLS] : [],
    supports_builtin_tools: supportsBuiltinTools,
  };
}

export function getBuiltinModelGroups() {
  return [...BUILTIN_MODEL_GROUPS, ...getPiProviderGroups()].map((group) => ({
    ...group,
    models: group.models.map(withBuiltinToolMetadata),
  }));
}

export function getBuiltinModels() {
  return [
    ...getBuiltinModelGroups().flatMap((group) => group.models),
    ...HIDDEN_LEGACY_MODELS.map(withBuiltinToolMetadata),
  ];
}

export function getBuiltinModelByReference(reference) {
  return getBuiltinModels().find((model) => model.value === reference) || null;
}

function inferFallbackCapabilities(resolved) {
  if (!resolved?.sdk) return null;
  if (resolved.sdk === "openai" || resolved.sdk === "codex") {
    const provider = resolved.sdk === "codex" ? "openai-codex" : "openai";
    try {
      return piModelCapabilities(getPiModel(provider, resolved.model));
    } catch {
      return openaiReasoningCapabilities(resolved.model);
    }
  }
  if (resolved.sdk === "pi") {
    try {
      return piModelCapabilities(getPiModel(resolved.provider, resolved.model));
    } catch {
      return openaiReasoningCapabilities(resolved.model);
    }
  }
  if (resolved.sdk === "claude" || resolved.sdk === "claude-code") {
    return claudeReasoningCapabilities(resolved.model, resolved.sdk === "claude-code" ? "cli" : "sdk");
  }
  return null;
}

function reasoningLevels(capabilities) {
  if (!capabilities || capabilities.reasoning === false || capabilities.reasoning_mode === "none") return [];
  if (Array.isArray(capabilities.reasoning_levels) && capabilities.reasoning_levels.length) {
    return capabilities.reasoning_levels.filter((level) => typeof level === "string");
  }
  return [...CLAUDE_REASONING_LEVELS];
}

function preferredEffort(levels, preferred = "medium") {
  if (levels.includes(preferred)) return preferred;
  if (levels.includes("low")) return "low";
  return levels[0] || "medium";
}

function nearestSupportedEffortAtOrBelow(levels, requested) {
  const requestedRank = REASONING_EFFORT_ORDER.indexOf(requested);
  if (requestedRank < 0) return levels[levels.length - 1];
  const ranked = levels
    .map((level) => ({ level, rank: REASONING_EFFORT_ORDER.indexOf(level) }))
    .filter((item) => item.rank >= 0 && item.rank <= requestedRank)
    .sort((left, right) => right.rank - left.rank);
  return ranked[0]?.level || preferredEffort(levels);
}

export function normalizeReasoningEffortForModel(modelRefOrResolved, effort, capabilities = null) {
  let resolved = null;
  if (typeof modelRefOrResolved === "string") {
    try { resolved = parseModelReference(modelRefOrResolved); } catch { resolved = null; }
  } else if (modelRefOrResolved?.sdk) {
    resolved = modelRefOrResolved;
  }

  const reference = resolved?.reference || (resolved?.sdk && resolved?.model ? `${resolved.sdk}:${resolved.model}` : null);
  const builtin = reference ? getBuiltinModelByReference(reference) : null;
  const caps = capabilities || builtin?.capabilities || inferFallbackCapabilities(resolved);
  const mode = caps?.reasoning_mode || (caps?.reasoning ? "effort" : "none");
  const requested = typeof effort === "string" && effort.trim() ? effort.trim() : null;

  if (mode === "none") return "low";
  if (mode === "toggle") return requested && requested !== "none" && requested !== "low" ? "medium" : "low";

  const levels = reasoningLevels(caps);
  if (!levels.length) return "low";
  if (!requested) return preferredEffort(levels);
  if (levels.includes(requested)) return requested;
  if (requested === "none" && levels.includes("low")) return "low";
  return nearestSupportedEffortAtOrBelow(levels, requested);
}

function requireModelPart(value, message) {
  if (!value || typeof value !== "string" || value.trim() !== value) {
    throw new Error(message);
  }
  return value;
}

export function parseModelReference(value) {
  if (!value || typeof value !== "string") throw new Error("model reference required");

  if (value.startsWith("vercel:")) {
    const rest = value.slice("vercel:".length);
    const i = rest.indexOf(":");
    if (i <= 0 || i === rest.length - 1) {
      throw new Error("invalid vercel model reference; expected vercel:<providerId>:<modelName>");
    }
    const providerId = requireModelPart(rest.slice(0, i), "provider id required");
    const modelName = requireModelPart(rest.slice(i + 1), "model name required");
    return { sdk: "vercel", model: modelName, providerId, modelName, reference: value };
  }

  if (value.startsWith("pi:")) {
    const rest = value.slice("pi:".length);
    const i = rest.indexOf(":");
    if (i <= 0 || i === rest.length - 1) {
      throw new Error("invalid pi model reference; expected pi:<providerId>:<modelName>");
    }
    const provider = requireModelPart(rest.slice(0, i), "provider id required");
    const model = requireModelPart(rest.slice(i + 1), "model id required");
    return { sdk: "pi", provider, model, reference: value };
  }

  const i = value.indexOf(":");
  if (i <= 0 || i === value.length - 1) {
    throw new Error("invalid model reference; expected <sdk>:<modelId>");
  }
  const sdk = value.slice(0, i);
  const model = requireModelPart(value.slice(i + 1), "model id required");
  if (sdk !== "claude" && sdk !== "openai" && sdk !== "claude-code" && sdk !== "codex") {
    throw new Error(`unknown sdk: ${sdk}`);
  }
  if (["haiku", "sonnet", "opus"].includes(model)) {
    throw new Error("tier aliases are not valid model references; use an exact model id");
  }
  return { sdk, model, reference: value };
}

export function isValidModelReference(value) {
  try {
    parseModelReference(value);
    return true;
  } catch {
    return false;
  }
}

export function resolveModel(value) {
  return parseModelReference(value);
}

async function loadBackend(sdk, { liveInput = false } = {}) {
  if (sdk === "claude") return (await import("./ai-claude.js")).claudeSdkBackend;
  if (sdk === "claude-code") return (await import("./ai-claude.js")).claudeSdkBackend;
  if (sdk === "openai") return (await import("./ai-pi.js")).piOpenAiBackend;
  if (sdk === "vercel") return (await import("./ai-pi.js")).piVercelBackend;
  if (sdk === "codex") return (await import("./ai-pi.js")).piCodexBackend;
  if (sdk === "pi") return (await import("./ai-pi.js")).piGenericBackend;
  throw new Error(`unsupported sdk: ${sdk}`);
}

export async function resolveBackendFor(modelRef, { liveInput = false } = {}) {
  const resolved = typeof modelRef === "string" ? parseModelReference(modelRef) : modelRef;
  return loadBackend(resolved.sdk, { liveInput });
}

export async function generateResponse(systemPrompt, options) {
  const resolved = options.model?.sdk ? options.model : parseModelReference(options.model);
  const nextOptions = resolved.sdk === "vercel"
    ? { ...options, model: resolved }
    : { ...options, model: resolved, effort: normalizeReasoningEffortForModel(resolved, options.effort || "medium") };
  const backend = await loadBackend(resolved.sdk, { liveInput: !!options.liveInput });
  return backend.execute(systemPrompt, nextOptions);
}
