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
