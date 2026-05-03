import { describe, expect, it } from "vitest";
import {
  hasModelPricingRates,
  modelPricingState,
  nextModelPricing,
} from "../../ui/src/routes/Providers.jsx";

describe("provider model pricing helpers", () => {
  it("normalizes entered rates and clears blank fields", () => {
    expect(nextModelPricing({}, "input_per_million", "2.5")).toEqual({ input_per_million: 2.5 });
    expect(nextModelPricing({
      input_per_million: 2.5,
      output_per_million: 8,
    }, "input_per_million", "")).toEqual({ output_per_million: 8 });
  });

  it("rejects invalid or negative rates", () => {
    expect(nextModelPricing({}, "input_per_million", "-1")).toBeNull();
    expect(nextModelPricing({}, "input_per_million", "not-a-number")).toBeNull();
  });

  it("distinguishes priced, local-zero, and unpriced models", () => {
    expect(hasModelPricingRates({ output_per_million: 0 })).toBe(true);
    expect(modelPricingState(
      { provider_type: "openai_compat", base_url: "https://api.example.com" },
      { pricing: { input_per_million: 1, output_per_million: 4 } },
    )).toBe("priced");
    expect(modelPricingState(
      { provider_type: "ollama", base_url: "http://localhost:11434" },
      { pricing: {} },
    )).toBe("local");
    expect(modelPricingState(
      { provider_type: "openai_compat", base_url: "https://api.example.com" },
      { pricing: {} },
    )).toBe("unpriced");
  });
});
