import { describe, expect, it } from "vitest";
import {
  filterProviderModels,
  hasModelPricingRates,
  modelPricingState,
  nextModelPricing,
} from "../../ui/src/routes/settings/ProvidersTab.jsx";

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

  it("filters discovered models by model metadata and derived state", () => {
    const provider = { provider_type: "openai_compat", base_url: "https://api.example.com" };
    const models = [
      {
        id: "chat",
        display_name: "Reasoning Chat",
        model_name: "reasoning-chat-v1",
        enabled: true,
        capabilities: { reasoning: true, tool_use: true, vision: true },
        pricing: { input_per_million: 1, output_per_million: 4 },
      },
      {
        id: "embed",
        display_name: "Knowledge Embedder",
        model_name: "text-embedding-v1",
        enabled: true,
        capabilities: { embedding: true, runnable_for_agent: false },
        pricing: {},
      },
      {
        id: "disabled",
        display_name: "Dormant Model",
        model_name: "dormant-v1",
        enabled: false,
        capabilities: {},
        pricing: {},
      },
    ];

    expect(filterProviderModels(provider, models, "")).toBe(models);
    expect(filterProviderModels(provider, models, "reasoning priced").map((model) => model.id)).toEqual(["chat"]);
    expect(filterProviderModels(provider, models, "knowledge embedding").map((model) => model.id)).toEqual(["embed"]);
    expect(filterProviderModels(provider, models, "disabled").map((model) => model.id)).toEqual(["disabled"]);
  });
});
