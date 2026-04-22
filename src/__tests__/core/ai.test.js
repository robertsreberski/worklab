import { describe, it, expect } from "vitest";
import { resolveModel, TIER_MODELS } from "../../core/ai.js";

describe("resolveModel", () => {
  it("bare 'sonnet' resolves to claude sonnet tier", () => {
    const r = resolveModel("sonnet");
    expect(r.sdk).toBe("claude");
    expect(r.tier).toBe("sonnet");
    expect(r.model).toBe(TIER_MODELS.sonnet);
  });

  it("bare 'opus' resolves to claude opus tier", () => {
    expect(resolveModel("opus").tier).toBe("opus");
  });

  it("bare 'haiku' resolves to claude haiku tier", () => {
    expect(resolveModel("haiku").tier).toBe("haiku");
  });

  it("claude: prefix resolves explicitly", () => {
    const r = resolveModel("claude:sonnet");
    expect(r.sdk).toBe("claude");
    expect(r.tier).toBe("sonnet");
  });

  it("rejects unknown sdk prefix", () => {
    expect(() => resolveModel("bogus:x")).toThrow(/unknown sdk/i);
  });

  it("rejects unknown claude tier", () => {
    expect(() => resolveModel("claude:mystery")).toThrow(/unknown tier/i);
  });

  it("accepts raw claude model id", () => {
    const r = resolveModel("claude-opus-4-7");
    expect(r.sdk).toBe("claude");
    expect(r.model).toBe("claude-opus-4-7");
  });
});
