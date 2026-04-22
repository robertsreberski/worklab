export const TIER_MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

function resolveClaude(tier) {
  if (tier in TIER_MODELS) return { sdk: "claude", tier, model: TIER_MODELS[tier] };
  if (/^claude-/.test(tier)) return { sdk: "claude", tier: null, model: tier };
  throw new Error(`unknown tier for claude: ${tier}`);
}

export function resolveModel(value) {
  if (!value) throw new Error("model value required");
  if (value.includes(":")) {
    const [sdk, rest] = value.split(":", 2);
    if (sdk === "claude") return resolveClaude(rest);
    throw new Error(`unknown sdk: ${sdk}`);
  }
  return resolveClaude(value);
}

export async function generateResponse(systemPrompt, options) {
  const resolved = options.model?.sdk ? options.model : resolveModel(options.model);
  if (resolved.sdk === "claude") {
    const { generateClaudeResponse } = await import("./ai-claude.js");
    return generateClaudeResponse(systemPrompt, { ...options, model: resolved });
  }
  throw new Error(`sdk not yet supported in phase 2: ${resolved.sdk}`);
}
