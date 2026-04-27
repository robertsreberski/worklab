export const BUILTIN_CLAUDE_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
];

export const BUILTIN_OPENAI_MODELS = [
  "gpt-5.5",
];

export const VALID_MODEL_SDKS = ["claude", "openai", "vercel", "claude-code", "codex"];
export const WORKLAB_BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"];

const MODEL_SHORT_LABELS = {
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "gpt-5.5": "GPT-5.5",
};

const CLAUDE_REASONING_LEVELS = ["low", "medium", "high", "xhigh"];
const OPENAI_REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh"];

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
  if (model.endsWith("-nano")) {
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
    reasoning_levels: OPENAI_REASONING_LEVELS,
    reasoning_disable_supported: true,
  };
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
    models: [
      {
        value: "openai:gpt-5.5",
        label: "GPT-5.5",
        description: "Flagship",
        sdk: "openai",
        model: "gpt-5.5",
        capabilities: openaiReasoningCapabilities("gpt-5.5"),
      },
    ],
  },
];

const CLI_MODEL_GROUPS = [
  {
    id: "claude-code",
    label: "Claude Code CLI",
    models: BUILTIN_CLAUDE_MODELS.map((model) => ({
      value: `claude-code:${model}`,
      label: `Claude Code ${MODEL_SHORT_LABELS[model] || model}`,
      description: "Runs through the local `claude` command",
      sdk: "claude-code",
      model,
      capabilities: {
        ...claudeReasoningCapabilities(model, "cli"),
        runtime: "cli",
      },
      builtin_tools: [...WORKLAB_BUILTIN_TOOLS],
      supports_builtin_tools: true,
    })),
  },
  {
    id: "codex",
    label: "Codex CLI",
    models: BUILTIN_OPENAI_MODELS.map((model) => ({
      value: `codex:${model}`,
      label: `Codex ${MODEL_SHORT_LABELS[model] || model}`,
      description: "Runs through the local `codex exec` command",
      sdk: "codex",
      model,
      capabilities: {
        ...openaiReasoningCapabilities(model, "cli"),
        runtime: "cli",
      },
      builtin_tools: [],
      supports_builtin_tools: false,
    })),
  },
];

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
  return [...BUILTIN_MODEL_GROUPS, ...CLI_MODEL_GROUPS].map((group) => ({
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
  if (resolved.sdk === "openai" || resolved.sdk === "codex") {
    return openaiReasoningCapabilities(resolved.model, resolved.sdk === "codex" ? "cli" : "sdk");
  }
  if (resolved.sdk === "claude" || resolved.sdk === "claude-code") {
    return claudeReasoningCapabilities(resolved.model, resolved.sdk === "claude-code" ? "cli" : "sdk");
  }
  return null;
}

function reasoningLevels(capabilities) {
  if (!capabilities || capabilities.reasoning === false || capabilities.reasoning_mode === "none") return [];
  if (Array.isArray(capabilities.reasoning_levels) && capabilities.reasoning_levels.length) {
    return capabilities.reasoning_levels.filter((level) => typeof level === "string" && level !== "max");
  }
  return [...CLAUDE_REASONING_LEVELS];
}

function preferredEffort(levels, preferred = "medium") {
  if (levels.includes(preferred)) return preferred;
  if (levels.includes("low")) return "low";
  return levels[0] || "medium";
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
  if (requested === "max") {
    if (levels.includes("xhigh")) return "xhigh";
    if (levels.includes("high")) return "high";
  }
  if (requested === "none" && levels.includes("low")) return "low";
  return levels[levels.length - 1];
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

export async function generateResponse(systemPrompt, options) {
  const resolved = options.model?.sdk ? options.model : parseModelReference(options.model);
  const nextOptions = resolved.sdk === "vercel"
    ? { ...options, model: resolved }
    : { ...options, model: resolved, effort: normalizeReasoningEffortForModel(resolved, options.effort || "medium") };
  if (resolved.sdk === "claude") {
    const { generateClaudeResponse } = await import("./ai-claude.js");
    return generateClaudeResponse(systemPrompt, nextOptions);
  }
  if (resolved.sdk === "openai") {
    const { generateOpenAIResponse } = await import("./ai-openai.js");
    return generateOpenAIResponse(systemPrompt, nextOptions);
  }
  if (resolved.sdk === "vercel") {
    const { generateVercelResponse } = await import("./ai-vercel.js");
    return generateVercelResponse(systemPrompt, nextOptions);
  }
  if (resolved.sdk === "claude-code" || resolved.sdk === "codex") {
    const { generateCliResponse } = await import("./ai-cli.js");
    return generateCliResponse(systemPrompt, nextOptions);
  }
  throw new Error(`unsupported sdk: ${resolved.sdk}`);
}
