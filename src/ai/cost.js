const PRICING = {
  "claude-haiku-4-5-20251001": { input: 1.0, cachedInput: 0.1, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, cachedInput: 0.3, output: 15.0 },
  "claude-opus-4-7": { input: 5.0, cachedInput: 0.5, output: 25.0 },
  "gpt-5.5": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
};

function customProviderPricing(db, reference) {
  if (!db || typeof reference !== "string") return null;
  const prefix = reference.startsWith("vercel:") ? "vercel:" : (reference.startsWith("pi:") ? "pi:" : null);
  if (!prefix) return null;
  const rest = reference.slice(prefix.length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const providerId = rest.slice(0, i);
  const modelName = rest.slice(i + 1);
  try {
    const row = db.prepare("SELECT pricing_json FROM custom_models WHERE provider_id = ? AND model_name = ?").get(providerId, modelName);
    if (!row?.pricing_json) return { input: 0, cachedInput: 0, output: 0 };
    const p = JSON.parse(row.pricing_json);
    return {
      input: Number(p.input_per_million) || 0,
      cachedInput: Number(p.cached_input_per_million) || 0,
      output: Number(p.output_per_million) || 0,
    };
  } catch {
    return { input: 0, cachedInput: 0, output: 0 };
  }
}

export function estimateCost({ db, model, inputTokens = 0, outputTokens = 0, cachedTokens = 0 }) {
  const modelId = typeof model === "string" && model.startsWith("pi:")
    ? model.slice(model.indexOf(":", "pi:".length) + 1)
    : (typeof model === "string" && model.includes(":") && !model.startsWith("vercel:")
        ? model.slice(model.indexOf(":") + 1)
        : model);
  const pricing = customProviderPricing(db, model) || PRICING[modelId] || { input: 0, cachedInput: 0, output: 0 };
  const freshInput = Math.max(0, inputTokens - cachedTokens);
  return (
    (freshInput / 1_000_000) * pricing.input +
    (cachedTokens / 1_000_000) * (pricing.cachedInput || pricing.input) +
    (outputTokens / 1_000_000) * pricing.output
  );
}
