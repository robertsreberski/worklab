import { getModel as getPiModel } from "@mariozechner/pi-ai";

const CLAUDE_PRICING = {
  "claude-haiku-4-5-20251001": { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0 },
  "claude-haiku-4-5": { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  "claude-sonnet-4-5": { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  "claude-sonnet-4": { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  "claude-opus-4-7": { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  "claude-opus-4-5": { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
};

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rate(value, fallback = 0) {
  const n = finiteOrNull(value);
  return n == null ? fallback : n;
}

function normalizePricing(pricing, { source, priced = true } = {}) {
  if (!pricing || typeof pricing !== "object") return null;
  const input = rate(pricing.input ?? pricing.input_per_million);
  const cacheRead = rate(
    pricing.cacheRead
      ?? pricing.cachedInput
      ?? pricing.cached_input_per_million,
    input,
  );
  const cacheWrite = rate(
    pricing.cacheWrite
      ?? pricing.cache_write_per_million
      ?? pricing.cache_creation_per_million,
  );
  const output = rate(pricing.output ?? pricing.output_per_million);
  return { input, cacheRead, cacheWrite, output, source, priced };
}

function zeroPricing(source) {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, source, priced: true };
}

function unknownPricing() {
  return { input: null, cacheRead: null, cacheWrite: null, output: null, source: "unknown", priced: false };
}

function parseReference(reference) {
  if (typeof reference !== "string" || !reference.trim()) return null;
  if (reference.startsWith("vercel:")) {
    const rest = reference.slice("vercel:".length);
    const i = rest.indexOf(":");
    return i > 0 ? { sdk: "pi", provider: rest.slice(0, i), model: rest.slice(i + 1) } : null;
  }
  if (reference.startsWith("codex:")) {
    return { sdk: "pi", provider: "openai-codex", model: reference.slice("codex:".length) };
  }
  if (reference.startsWith("openai:")) {
    return { sdk: "pi", provider: "openai", model: reference.slice("openai:".length) };
  }
  if (reference.startsWith("pi:")) {
    const rest = reference.slice("pi:".length);
    const i = rest.indexOf(":");
    return i > 0 ? { sdk: "pi", provider: rest.slice(0, i), model: rest.slice(i + 1) } : null;
  }
  const i = reference.indexOf(":");
  if (i <= 0) return { sdk: null, model: reference };
  return { sdk: reference.slice(0, i), model: reference.slice(i + 1) };
}

function isPrivateHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost"
      || host === "host.docker.internal"
      || host === "::1"
      || host.startsWith("127.")
      || host.startsWith("10.")
      || host.startsWith("192.168.")
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
  } catch {
    return false;
  }
}

function pricingHasRates(pricing = {}) {
  return [
    pricing.input_per_million,
    pricing.cached_input_per_million,
    pricing.cache_write_per_million,
    pricing.output_per_million,
  ].some((value) => finiteOrNull(value) != null);
}

function customProviderPricing(db, parsed) {
  if (!db || !parsed?.provider || !parsed?.model) return null;
  try {
    const row = db.prepare(`
      SELECT m.pricing_json, p.provider_type, p.base_url
      FROM custom_models m
      JOIN custom_providers p ON p.id = m.provider_id
      WHERE m.provider_id = ? AND m.model_name = ?
    `).get(parsed.provider, parsed.model);
    if (!row) return null;
    const pricing = row.pricing_json ? JSON.parse(row.pricing_json) : {};
    if (pricingHasRates(pricing)) {
      return normalizePricing(pricing, { source: "custom" });
    }
    if (["ollama", "lmstudio", "vllm"].includes(row.provider_type) || isPrivateHost(row.base_url)) {
      return zeroPricing("custom-local");
    }
    return unknownPricing();
  } catch {
    return unknownPricing();
  }
}

function piCatalogPricing(parsed) {
  if (parsed?.sdk !== "pi" || !parsed.provider || !parsed.model) return null;
  try {
    const model = getPiModel(parsed.provider, parsed.model);
    return model?.cost ? normalizePricing(model.cost, { source: "pi-catalog" }) : null;
  } catch {
    return null;
  }
}

function claudePricing(parsed) {
  if (parsed?.sdk !== "claude") return null;
  return normalizePricing(CLAUDE_PRICING[parsed.model], { source: "claude-table" });
}

export function resolvePricing({ db, model } = {}) {
  const parsed = parseReference(model);
  if (!parsed) return unknownPricing();
  return customProviderPricing(db, parsed)
    || piCatalogPricing(parsed)
    || claudePricing(parsed)
    || unknownPricing();
}

export function estimateCost({
  db,
  model,
  inputTokens = 0,
  outputTokens = 0,
  cachedTokens = 0,
  cacheWriteTokens = 0,
  cacheCreationTokens = 0,
} = {}) {
  const pricing = resolvePricing({ db, model });
  if (!pricing?.priced) return null;
  const cacheRead = Math.max(0, Number(cachedTokens) || 0);
  const cacheWrite = Math.max(0, Number(cacheWriteTokens ?? cacheCreationTokens) || 0);
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  return (
    (input / 1_000_000) * pricing.input +
    (cacheRead / 1_000_000) * pricing.cacheRead +
    (cacheWrite / 1_000_000) * pricing.cacheWrite +
    (output / 1_000_000) * pricing.output
  );
}
