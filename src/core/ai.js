import { getModel as getPiModel, getModels as getPiModels, supportsXhigh } from "@mariozechner/pi-ai";
import { getSkillAccessDirs } from "../agent/prompt/skill-index.js";
import {
  canonicalizeLegacyModelReference,
  normalizeRuntimeModelReference,
  parseRuntimeModelReference,
} from "../ai/runtime/model-refs.js";
import { resolveRuntimeBridge } from "../ai/runtime/registry.js";
import { readSettings } from "./settings.js";
import {
  buildModelCapabilities,
  getModelByProviderAndName,
  getProvider,
  isPrivateBaseUrl,
  resolveReasoningCapabilities,
} from "./providers.js";

export const BUILTIN_CLAUDE_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
];

const FALLBACK_OPENAI_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
];

const FALLBACK_CODEX_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
];

function piModelIds(provider, fallback) {
  try {
    const ids = getPiModels(provider).map((model) => model.id).filter(Boolean);
    return ids.length ? ids : fallback;
  } catch {
    return fallback;
  }
}

export const BUILTIN_OPENAI_MODELS = piModelIds("openai", FALLBACK_OPENAI_MODELS);
export const BUILTIN_CODEX_MODELS = piModelIds("openai-codex", FALLBACK_CODEX_MODELS);

export const VALID_MODEL_SDKS = ["claude", "pi"];
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

function piModelMetadata(provider, modelId, { labelPrefix = "", description = null } = {}) {
  let model;
  try {
    model = getPiModel(provider, modelId);
  } catch {
    model = null;
  }
  const label = [labelPrefix, model?.name || MODEL_SHORT_LABELS[modelId] || modelId].filter(Boolean).join(" ");
  return {
    value: `pi:${provider}:${modelId}`,
    label,
    description: description || model?.name || null,
    sdk: "pi",
    provider,
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
    id: "pi:openai",
    label: "OpenAI",
    models: BUILTIN_OPENAI_MODELS.map((model) => piModelMetadata("openai", model, {
      description: model === "gpt-5.5" ? "Flagship" : null,
    })),
  },
  {
    id: "pi:openai-codex",
    label: "OpenAI Codex",
    models: BUILTIN_CODEX_MODELS.map((model) => piModelMetadata("openai-codex", model, {
      labelPrefix: "Codex",
      description: `ChatGPT OAuth via pi-ai / ${model}`,
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
  return getBuiltinModelGroups().flatMap((group) => group.models);
}

export function getBuiltinModelByReference(reference) {
  return getBuiltinModels().find((model) => model.value === reference) || null;
}

function inferFallbackCapabilities(resolved) {
  if (!resolved?.sdk) return null;
  if (resolved.sdk === "pi") {
    try {
      return piModelCapabilities(getPiModel(resolved.provider, resolved.model));
    } catch {
      return openaiReasoningCapabilities(resolved.model);
    }
  }
  if (resolved.sdk === "claude") {
    return claudeReasoningCapabilities(resolved.model);
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

export function parseModelReference(value) {
  return parseRuntimeModelReference(value);
}

export function normalizeModelReference(value) {
  return normalizeRuntimeModelReference(value);
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

export async function resolveBackendFor(modelRef, { liveInput = false } = {}) {
  const resolved = typeof modelRef === "string" ? parseModelReference(modelRef) : modelRef;
  return resolveRuntimeBridge(resolved, { liveInput });
}

function loadSettingsSafely(db) {
  if (!db) return {};
  try {
    return readSettings(db);
  } catch {
    return {};
  }
}

function piProviderExists(provider) {
  try {
    return getPiModels(provider).length > 0;
  } catch {
    return false;
  }
}

function resolveCustomProviderContext(resolved, { db, dataDir }) {
  if (resolved.sdk !== "pi" || piProviderExists(resolved.provider)) return null;
  const provider = getProvider({ db, dataDir, id: resolved.provider, includeKey: true });
  if (!provider) {
    throw new Error(`provider not found: ${resolved.provider}`);
  }
  const modelRow = getModelByProviderAndName({
    db,
    providerId: resolved.provider,
    modelName: resolved.model,
  }) || null;
  const capabilities = modelRow
    ? buildModelCapabilities(provider.provider_type, resolved.model, modelRow.capabilities)
    : resolveReasoningCapabilities(provider.provider_type, resolved.model, {});
  return {
    customProvider: provider,
    customModel: modelRow,
    modelCapabilities: capabilities,
    isPrivateProvider: isPrivateBaseUrl(provider.base_url),
  };
}

function runtimeProviderError(resolved, message) {
  return {
    text: null,
    events: [],
    usage: {},
    durationMs: 0,
    numTurns: 0,
    model: resolved?.reference || resolved?.model || null,
    effort: null,
    sdk: resolved?.sdk || null,
    cancelled: false,
    error: message,
    failureKind: "provider_unavailable",
    runtimeWarnings: [],
    diagnostics: { provider_error: true },
  };
}

// Caller-side dependency injection: providers (src/ai/providers/*) must not
// reach back into core/. generateResponse pre-computes everything those
// adapters need — normalized effort, settings, skill access dirs, and (for
// custom Pi providers) the provider/model rows + capabilities — and passes
// them through options.
export async function generateResponse(systemPrompt, options) {
  const resolved = options.model?.sdk ? options.model : parseModelReference(options.model);
  const skillDirs = Array.isArray(options.skillDirs)
    ? options.skillDirs
    : getSkillAccessDirs(options.skills || []);
  const settings = options.settings || loadSettingsSafely(options.db);
  let customContext = null;
  if (resolved.sdk === "pi") {
    try {
      customContext = resolveCustomProviderContext(resolved, {
        db: options.db,
        dataDir: options.dataDir,
      });
    } catch (err) {
      return runtimeProviderError(resolved, err?.message || String(err));
    }
  }
  const baseOptions = {
    ...options,
    model: resolved,
    skillDirs,
    settings,
    ...(customContext || {}),
  };
  const nextOptions = {
    ...baseOptions,
    effort: normalizeReasoningEffortForModel(resolved, options.effort || "medium", customContext?.modelCapabilities),
  };
  const backend = await resolveRuntimeBridge(resolved, { liveInput: !!options.liveInput });
  return backend.execute(systemPrompt, nextOptions);
}

export { canonicalizeLegacyModelReference };
