// Worklab's host implementation of `resolveCustomPricing` for the agent runtime.
// The package's cost helpers are shape converters; the SQL against the
// `custom_models` / `custom_providers` tables stays here.
import { getPiModel } from "./pi-model-catalog.js";
import {
  isPrivateHost,
  normalizePricing,
  pricingHasRates,
  unknownPricing,
  zeroPricing,
} from "@mono-agent/agent-runtime/ai/cost.js";

const LOCAL_PROVIDER_TYPES = new Set(["ollama", "lmstudio", "vllm"]);

function piCatalogPricing(parsed) {
  if (parsed?.sdk !== "pi" || !parsed.provider || !parsed.model) return null;
  try {
    const model = getPiModel(parsed.provider, parsed.model);
    return model?.cost ? normalizePricing(model.cost, { source: "pi-catalog" }) : null;
  } catch {
    return null;
  }
}

export function customProviderPricing(db, parsed) {
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
      return normalizePricing(pricing, { source: "custom", missing: null });
    }
    if (LOCAL_PROVIDER_TYPES.has(row.provider_type) || isPrivateHost(row.base_url)) {
      return zeroPricing("custom-local");
    }
    return unknownPricing();
  } catch {
    return unknownPricing();
  }
}

export function customPricingResolverFor(db) {
  return (parsed) => customProviderPricing(db, parsed) || piCatalogPricing(parsed);
}
