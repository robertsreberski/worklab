export const BUILTIN_CLAUDE_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
];

export const BUILTIN_OPENAI_MODELS = [
  "gpt-5.4-nano",
  "gpt-5.4-mini",
  "gpt-5.4",
];

export const VALID_MODEL_SDKS = ["claude", "openai", "vercel"];
export const WORKLAB_BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"];

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
        capabilities: {
          tool_use: true,
          reasoning: false,
          reasoning_mode: "none",
          vision: true,
          json_mode: true,
        },
      },
      {
        value: "claude:claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "Balanced",
        sdk: "claude",
        model: "claude-sonnet-4-6",
        capabilities: {
          tool_use: true,
          reasoning: true,
          reasoning_mode: "effort",
          reasoning_levels: ["low", "medium", "high", "max"],
          reasoning_disable_supported: true,
          vision: true,
          json_mode: true,
        },
      },
      {
        value: "claude:claude-opus-4-7",
        label: "Claude Opus 4.7",
        description: "Most capable",
        sdk: "claude",
        model: "claude-opus-4-7",
        capabilities: {
          tool_use: true,
          reasoning: true,
          reasoning_mode: "effort",
          reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
          reasoning_disable_supported: true,
          vision: true,
          json_mode: true,
        },
      },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: [
      {
        value: "openai:gpt-5.4-nano",
        label: "GPT-5.4 Nano",
        description: "Fast",
        sdk: "openai",
        model: "gpt-5.4-nano",
        capabilities: {
          tool_use: true,
          reasoning: false,
          reasoning_mode: "none",
          vision: true,
          json_mode: true,
        },
      },
      {
        value: "openai:gpt-5.4-mini",
        label: "GPT-5.4 Mini",
        description: "Balanced",
        sdk: "openai",
        model: "gpt-5.4-mini",
        capabilities: {
          tool_use: true,
          reasoning: true,
          reasoning_mode: "effort",
          reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
          reasoning_disable_supported: true,
          vision: true,
          json_mode: true,
        },
      },
      {
        value: "openai:gpt-5.4",
        label: "GPT-5.4",
        description: "Most capable",
        sdk: "openai",
        model: "gpt-5.4",
        capabilities: {
          tool_use: true,
          reasoning: true,
          reasoning_mode: "effort",
          reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
          reasoning_disable_supported: true,
          vision: true,
          json_mode: true,
        },
      },
    ],
  },
];

function withBuiltinToolMetadata(model) {
  const supportsBuiltinTools = model?.capabilities?.tool_use !== false;
  return {
    ...model,
    builtin_tools: supportsBuiltinTools ? [...WORKLAB_BUILTIN_TOOLS] : [],
    supports_builtin_tools: supportsBuiltinTools,
  };
}

export function getBuiltinModelGroups() {
  return BUILTIN_MODEL_GROUPS.map((group) => ({
    ...group,
    models: group.models.map(withBuiltinToolMetadata),
  }));
}

export function getBuiltinModels() {
  return getBuiltinModelGroups().flatMap((group) => group.models);
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
  if (sdk !== "claude" && sdk !== "openai") {
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
  if (resolved.sdk === "claude") {
    const { generateClaudeResponse } = await import("./ai-claude.js");
    return generateClaudeResponse(systemPrompt, { ...options, model: resolved });
  }
  if (resolved.sdk === "openai") {
    const { generateOpenAIResponse } = await import("./ai-openai.js");
    return generateOpenAIResponse(systemPrompt, { ...options, model: resolved });
  }
  if (resolved.sdk === "vercel") {
    const { generateVercelResponse } = await import("./ai-vercel.js");
    return generateVercelResponse(systemPrompt, { ...options, model: resolved });
  }
  throw new Error(`unsupported sdk: ${resolved.sdk}`);
}
