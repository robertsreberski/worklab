import { reasoningLevelsForPiModel } from "@mono-agent/agent-runtime/ai";
import {
  canonicalizeLegacyModelReference,
  normalizeRuntimeModelReference,
  parseRuntimeModelReference,
} from "@mono-agent/agent-runtime/ai/runtime/model-refs.js";
import { claudeModelSupportsOneMillionContext } from "@mono-agent/agent-runtime/ai/runtime/context-windows.js";
import { codexModelSupportsFastMode } from "@mono-agent/agent-runtime/ai/runtime/fast-mode.js";
import { createRouterRuntime, createRuntime, createMetricsObserver } from "@mono-agent/agent-runtime";
import { WORKLAB_BUILTIN_TOOLS } from "./builtin-tools.js";
import { customPricingResolverFor } from "./custom-pricing.js";
import { getPiModel, getPiModels } from "./pi-model-catalog.js";
import { resolvePiApiKey } from "./pi-oauth.js";
import { compactionRecorderFor } from "./run-compactions.js";
import { runtimePoliciesFromSettings } from "./runtime-policies.js";
import { projectToolPolicy } from "./tool-policy-projection.js";
import { withWorklabRuntimeBrand } from "./runtime-brand.js";
import { getSkillAccessDirs, inferSkillsRoot } from "./skills.js";
import { createToolOutputSink } from "./tool-artifacts.js";
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
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-5",
  "claude-fable-5",
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

export const VALID_MODEL_SDKS = ["claude", "pi", "codex", "opencode"];
export { WORKLAB_BUILTIN_TOOLS };

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
  "claude-opus-4-6": "Opus 4.6",
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
    supports_native_subagents: true,
    native_tools_note: nativeToolsNote || null,
    mcp_mode: mcpMode || null,
    skills_mode: skillsMode,
  };
}

function claudeReasoningCapabilities(model, runtime = "sdk") {
  const optionalOneMillionContext = claudeModelSupportsOneMillionContext(model);
  const oneMillionContext = optionalOneMillionContext
    || model === "claude-fable-5"
    || model === "claude-opus-5";
  const common = {
    tool_use: true,
    vision: true,
    json_mode: true,
    context_window_tokens: oneMillionContext ? 1_000_000 : 200_000,
    supports_1m_context: optionalOneMillionContext,
    context_windows: optionalOneMillionContext ? ["default", "1m"] : ["default"],
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
    reasoning_levels: /opus|fable/.test(model) ? CLAUDE_REASONING_LEVELS : CLAUDE_REASONING_LEVELS.filter((level) => level !== "xhigh"),
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
  let levels = [];
  try {
    // The runtime's façade is pi's getSupportedThinkingLevels() with `off`
    // spelled `none`; Worklab only inspects the result for `xhigh`.
    levels = reasoningLevelsForPiModel(model);
  } catch {
    levels = [];
  }
  return ["none", "low", "medium", "high", ...(levels.includes("xhigh") ? ["xhigh"] : [])];
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

function codexModelMetadata(modelId) {
  const supportsFastMode = codexModelSupportsFastMode(modelId);
  return {
    value: `codex:${modelId}`,
    label: `Codex ${MODEL_SHORT_LABELS[modelId] || modelId}`,
    description: `Codex CLI / ${modelId}`,
    sdk: "codex",
    model: modelId,
    capabilities: {
      ...openaiReasoningCapabilities(modelId, "cli"),
      supports_fast_mode: supportsFastMode,
      fast_mode_default: supportsFastMode,
    },
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
        value: "claude:claude-opus-4-6",
        label: "Claude Opus 4.6",
        description: "Deep reasoning",
        sdk: "claude",
        model: "claude-opus-4-6",
        capabilities: claudeReasoningCapabilities("claude-opus-4-6"),
      },
      {
        value: "claude:claude-opus-4-7",
        label: "Claude Opus 4.7",
        description: "Most capable",
        sdk: "claude",
        model: "claude-opus-4-7",
        capabilities: claudeReasoningCapabilities("claude-opus-4-7"),
      },
      {
        value: "claude:claude-opus-5",
        label: "Claude Opus 5",
        description: "Advanced reasoning",
        sdk: "claude",
        model: "claude-opus-5",
        capabilities: claudeReasoningCapabilities("claude-opus-5"),
      },
      {
        value: "claude:claude-fable-5",
        label: "Claude Fable 5",
        description: "Frontier reasoning",
        sdk: "claude",
        model: "claude-fable-5",
        capabilities: claudeReasoningCapabilities("claude-fable-5"),
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
  {
    id: "codex",
    label: "Codex CLI",
    models: BUILTIN_CODEX_MODELS.map((model) => codexModelMetadata(model)),
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
  if (resolved.sdk === "codex") {
    return openaiReasoningCapabilities(resolved.model, "cli");
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

export async function resolveBackendFor(modelRef, { liveInput = false, executionMode = "sdk" } = {}) {
  const resolved = typeof modelRef === "string" ? parseModelReference(modelRef) : modelRef;
  return resolveRuntimeBridge(resolved, { liveInput, executionMode });
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

function optionalOption(value) {
  return value !== undefined && value !== null && value !== "" ? value : undefined;
}

function optionOrEnv(optionValue, envValue) {
  const explicit = optionalOption(optionValue);
  return explicit !== undefined ? explicit : optionalOption(envValue);
}

const PI_INLINE_READ_ONLY_TOOLS = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
]);

function piInlineAllowedTools(allowedTools, disallowedTools) {
  const allowed = Array.isArray(allowedTools) ? allowedTools : ["*"];
  const denied = new Set(Array.isArray(disallowedTools) ? disallowedTools : []);
  if (denied.has("*")) return [];
  const allowAll = allowed.includes("*");
  return PI_INLINE_READ_ONLY_TOOLS.filter((tool) =>
    (allowAll || allowed.includes(tool)) && !denied.has(tool));
}

// Caller-side dependency injection: providers (src/ai/providers/*) must not
// reach back into core/. generateResponse pre-computes everything those
// adapters need — normalized effort, settings, skill access dirs, and (for
// custom Pi providers) the provider/model rows + capabilities — and passes
// them through options.
//
// Host-level wiring (pricing / pi-oauth / artifact sink / compaction records)
// is set once on the per-call `createRuntime({ ... })` so the package's
// observer + brand surfaces stay reachable. Per-call options keep working
// (the package merges host defaults with per-call options).
//
// Every caller's `runtimeWarnings` are mirrored back into the `onEvent`
// stream as `runtime_warning` events after the run completes. This used to
// be duplicated in assistant.js / slack/service.js; now there's a single
// invariant: `result.runtimeWarnings` and the in-stream `runtime_warning`
// events agree. `onEvent` defaults to a no-op so a forgetful caller doesn't
// silently swallow events.
export async function generateResponse(systemPrompt, options) {
  const resolved = options.model?.sdk ? options.model : parseModelReference(options.model);
  const skills = Array.isArray(options.skills) ? options.skills : [];
  const skillDirs = Array.isArray(options.skillDirs)
    ? options.skillDirs
    : getSkillAccessDirs(skills);
  // agent-runtime 0.16+ treats skills as a route capability and requires the
  // directory containing `<name>/SKILL.md` to build ReadSkill. Worklab loads
  // every run's disclosed skills from one data-dir root, so thread that root
  // explicitly instead of relying on the runtime's legacy dataDir fallback.
  const skillsRoot = skills.length > 0
    ? optionalOption(options.skillsRoot) ?? optionalOption(inferSkillsRoot(skills))
    : undefined;
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
  const codexThreadStartTimeoutMs = optionOrEnv(
    options.codexThreadStartTimeoutMs,
    process.env.WORKLAB_CODEX_THREAD_START_TIMEOUT_MS,
  );
  const codexThreadStartAttempts = optionOrEnv(
    options.codexThreadStartAttempts,
    process.env.WORKLAB_CODEX_THREAD_START_ATTEMPTS,
  );
  const codexThreadStartBackoffMs = optionOrEnv(
    options.codexThreadStartBackoffMs,
    process.env.WORKLAB_CODEX_THREAD_START_BACKOFF_MS,
  );
  const piCodexTransport = optionOrEnv(
    options.piCodexTransport,
    process.env.WORKLAB_PI_CODEX_TRANSPORT,
  ) ?? optionalOption(settings.agent_pi_codex_transport) ?? null;

  const runArtifactDir = options.runArtifactDir || process.env.WORKLAB_QA_OUTPUT_DIR || null;
  // One metrics observer per call; snapshot folded back onto the result so the
  // coordinator persists it (Phase 1 wired tool_usage_summary_json). Callers
  // can also attach their own observers via options.observers and they ride
  // alongside this one.
  const metricsObserver = createMetricsObserver();
  const callObservers = Array.isArray(options.observers) ? options.observers : [];
  const hostOptions = withWorklabRuntimeBrand({
    resolveCustomPricing: options.resolveCustomPricing || customPricingResolverFor(options.db),
    onCompactionRecorded: options.onCompactionRecorded || compactionRecorderFor(options.db),
    persistArtifact: options.persistArtifact || createToolOutputSink(runArtifactDir),
    resolvePiApiKey: options.resolvePiApiKey
      || ((provider) => resolvePiApiKey(provider, { dataDir: options.dataDir })),
    observers: [metricsObserver, ...callObservers],
  });

  const callerOnEvent = typeof options.onEvent === "function" ? options.onEvent : null;
  const onEvent = callerOnEvent || (() => {});

  // Typed policy objects supersede the deprecated `settings` bag as the
  // runtime's tool-limit / compaction source. Precedence is per-group: a
  // present typed object wins wholesale and its group's legacy settings keys
  // are never consulted, so no `deprecated_settings_option` warning fires.
  // `settings` stays on the bag because other Worklab code reads it off
  // `options`.
  const { toolLimits, compaction } = runtimePoliciesFromSettings(settings);

  // Direct Codex/OpenCode reject anything but the exact allow-all contract, so
  // an "allow every builtin" policy has to be spelled `["*"]` for them. This is
  // the single choke point where the resolved runtime is known, which is why it
  // lives here rather than in run-input.js.
  const toolPolicy = projectToolPolicy(resolved, {
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    // Set by applyPlanningToolPolicy. The read-only planning policy is the one
    // restriction a non-projecting runtime can honour, via its native plan mode.
    planning: options.toolPolicy?.planning === true,
    permissionMode: options.permissionMode,
  });
  if (toolPolicy.droppedNetworkTools.length) {
    // Provider-native read-only mode pins networkAccess:false, so tools the
    // planning policy granted stop working. Surface it rather than letting the
    // agent discover it as a mid-run tool failure.
    onEvent({
      type: "runtime_warning",
      warning_kind: "tool_policy_downgraded",
      message: `${resolved.sdk} enforces read-only planning natively, which disables network access: `
        + `${toolPolicy.droppedNetworkTools.join(", ")} are unavailable for this run.`,
    });
  }

  // Provider-native discovery options share one run-level bag. Router attempts
  // replace only `model`, so selecting these from the primary SDK would make a
  // fallback silently lose the option meant for its adapter. Each adapter
  // ignores the options it does not own.
  //
  // Claude Agent SDK: agent-runtime defaults user/project/local sources to an
  // explicit empty list (managed policy still applies), so a Worklab run would
  // not see `.claude/agents`. Opt in to the same filesystem sources the Claude
  // Code CLI already reads on its own. These sources may also contain hooks and
  // plugins; this is an intentional native-CLI compatibility boundary.
  //
  // Pi: inline helpers may never receive more than both the parent's logical
  // effective policy and Worklab's read-only helper ceiling. Use the logical
  // pre-projection policy here: a direct-Codex primary can be projected to `*`,
  // but a later Pi route must not mistake that provider representation for a
  // wider parent grant. If the intersection is empty, omit subagents entirely;
  // older runtimes interpret an explicit empty inline list as their default.
  //
  // Codex: Worklab already loads repository instructions into its own prompt,
  // but native subagents need Codex to load project docs for their own turns.
  const inlineAllowedTools = piInlineAllowedTools(options.allowedTools, options.disallowedTools);
  const providerNativeOptions = {
    settingSources: ["user", "project", "local"],
    codexLoadProjectDocs: true,
    ...(inlineAllowedTools.length > 0 ? {
      subagents: {
        inline: { enabled: true, allowedTools: inlineAllowedTools },
        maxConcurrent: 3,
        maxPerTurn: 10,
      },
    } : {}),
  };

  const baseOptions = {
    ...options,
    model: resolved,
    skillDirs,
    ...providerNativeOptions,
    ...(skillsRoot === undefined ? {} : { skillsRoot }),
    settings,
    toolLimits,
    compaction,
    allowedTools: toolPolicy.allowedTools,
    disallowedTools: toolPolicy.disallowedTools,
    ...(toolPolicy.permissionMode !== undefined ? { permissionMode: toolPolicy.permissionMode } : {}),
    runId: options.runId || process.env.WORKLAB_RUN_ID || null,
    providerSessionId: options.providerSessionId || process.env.WORKLAB_PROVIDER_SESSION_ID || null,
    runArtifactDir,
    piCodexTransport,
    onEvent,
    ...(options.codexAppServerCommand
      ? {
        codexAppServerCommand: options.codexAppServerCommand,
        codexAppServerArgs: options.codexAppServerArgs,
      }
      : process.env.WORKLAB_CODEX_APP_SERVER_COMMAND
        ? {
          codexAppServerCommand: process.env.WORKLAB_CODEX_APP_SERVER_COMMAND,
          codexAppServerArgs: [],
        }
        : {}),
    ...(codexThreadStartTimeoutMs !== undefined ? { codexThreadStartTimeoutMs } : {}),
    ...(codexThreadStartAttempts !== undefined ? { codexThreadStartAttempts } : {}),
    ...(codexThreadStartBackoffMs !== undefined ? { codexThreadStartBackoffMs } : {}),
    ...(customContext || {}),
  };
  const nextOptions = {
    ...baseOptions,
    effort: normalizeReasoningEffortForModel(resolved, options.effort || "medium", customContext?.modelCapabilities),
    executionMode: typeof options.executionMode === "string" ? options.executionMode : "sdk",
  };
  // When the agent has a fallback chain configured, route through
  // createRouterRuntime so retryable provider failures cascade to the next
  // model in the chain (replaying transcript-tail so the second attempt
  // continues rather than restarts). Single-model runs keep using
  // createRuntime to avoid the chain overhead.
  const fallbackChain = Array.isArray(options.fallbackChain) && options.fallbackChain.length > 0
    ? options.fallbackChain.filter((entry) => entry && (entry.model || entry.sdk))
    : null;
  const runtime = fallbackChain && fallbackChain.length > 0
    ? createRouterRuntime({
      host: hostOptions,
      chain: [
        // Primary model is always tried first; downstream entries are the
        // host's declared fallbacks.
        { sdk: resolved.sdk, model: resolved.model, ...(resolved.provider ? { provider: resolved.provider } : {}) },
        ...fallbackChain,
      ],
    })
    : createRuntime(hostOptions);
  const result = await runtime.run(systemPrompt, nextOptions);
  // Mirror runtimeWarnings into the event stream so every caller's onEvent
  // sees them. Without this, only callers that manually walk result.runtimeWarnings
  // surface warnings to the UI — see audit finding (a) on the agent-runtime
  // usage in worklab.
  if (callerOnEvent && Array.isArray(result?.runtimeWarnings) && result.runtimeWarnings.length > 0) {
    for (const warning of result.runtimeWarnings) {
      try { callerOnEvent({ type: "runtime_warning", ...warning }); } catch { /* host emit errors must not escape */ }
    }
  }
  // Fold the metrics-observer snapshot back onto the result so the worker
  // emits it on the final event and the coordinator persists it.
  if (result && typeof result === "object" && !result.observerSnapshot) {
    try { result.observerSnapshot = metricsObserver.snapshot(); } catch { /* defensive */ }
  }
  return result;
}

export { canonicalizeLegacyModelReference };
