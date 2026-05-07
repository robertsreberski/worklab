import { describe, expect, it } from "vitest";
import { estimateCost, resolvePricing } from "@worklab/agent-runtime/ai/cost.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import { createProvider, upsertModel } from "../../core/providers.js";

function withDb(fn) {
  const db = openDb(":memory:");
  runMigrations(db);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe("cost estimation", () => {
  it("uses pi-ai catalog pricing for built-in Pi providers beyond the static fallback table", () => {
    expect(estimateCost({
      model: "pi:openai-codex:gpt-5.3-codex",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedTokens: 0,
    })).toBeCloseTo(15.75);

    expect(estimateCost({
      model: "pi:google:gemini-2.5-flash",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedTokens: 0,
    })).toBeCloseTo(2.8);
  });

  it("prices cache reads and cache writes independently when the catalog exposes both rates", () => {
    const cost = estimateCost({
      model: "pi:openrouter:anthropic/claude-sonnet-4.5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedTokens: 100_000,
      cacheWriteTokens: 200_000,
    });

    expect(cost).toBeCloseTo(18.78);
  });

  it("uses current Claude API pricing including cache writes", () => {
    expect(estimateCost({
      model: "claude:claude-opus-4-7",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedTokens: 100_000,
      cacheWriteTokens: 200_000,
    })).toBeCloseTo(31.3);
  });

  it("uses custom provider pricing and returns null for unknown hosted pricing", () => withDb((db) => {
    const provider = createProvider({
      db,
      name: "hosted",
      provider_type: "openai_compat",
      base_url: "https://api.example.com",
      trust_public_url: true,
    });
    upsertModel({
      db,
      providerId: provider.id,
      modelName: "priced",
      pricing: {
        input_per_million: 2,
        cached_input_per_million: 0.2,
        cache_write_per_million: 2.5,
        output_per_million: 8,
      },
    });
    upsertModel({
      db,
      providerId: provider.id,
      modelName: "unknown",
    });

    expect(estimateCost({
      db,
      model: `pi:${provider.id}:priced`,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedTokens: 100_000,
      cacheWriteTokens: 200_000,
    })).toBeCloseTo(10.52);

    expect(estimateCost({
      db,
      model: `pi:${provider.id}:unknown`,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })).toBeNull();
    expect(resolvePricing({ db, model: `pi:${provider.id}:unknown` })).toMatchObject({
      source: "unknown",
      priced: false,
    });
  }));

  it("does not undercount hosted custom models when a used rate is missing", () => withDb((db) => {
    const provider = createProvider({
      db,
      name: "hosted",
      provider_type: "openai_compat",
      base_url: "https://api.example.com",
      trust_public_url: true,
    });
    upsertModel({
      db,
      providerId: provider.id,
      modelName: "partial",
      pricing: {
        input_per_million: 2,
      },
    });

    expect(estimateCost({
      db,
      model: `pi:${provider.id}:partial`,
      inputTokens: 1_000_000,
      outputTokens: 0,
    })).toBeCloseTo(2);
    expect(estimateCost({
      db,
      model: `pi:${provider.id}:partial`,
      inputTokens: 1_000_000,
      outputTokens: 1,
    })).toBeNull();
  }));

  it("treats private/local custom providers as explicit zero marginal cost unless pricing is entered", () => withDb((db) => {
    const provider = createProvider({
      db,
      name: "local",
      provider_type: "ollama",
      base_url: "http://localhost:11434",
    });
    upsertModel({ db, providerId: provider.id, modelName: "llama3" });

    expect(estimateCost({
      db,
      model: `pi:${provider.id}:llama3`,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })).toBe(0);
  }));
});
