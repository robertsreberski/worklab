import { describe, it, expect } from "vitest";
import { parseModelReference, resolveModel, isValidModelReference } from "../../core/ai.js";

describe("explicit model references", () => {
  it("parses an exact Claude model reference", () => {
    expect(parseModelReference("claude:claude-sonnet-4-6")).toEqual({
      sdk: "claude",
      model: "claude-sonnet-4-6",
      reference: "claude:claude-sonnet-4-6",
    });
  });

  it("parses an exact OpenAI model reference", () => {
    expect(resolveModel("openai:gpt-5.4-mini")).toMatchObject({
      sdk: "openai",
      model: "gpt-5.4-mini",
    });
  });

  it("parses a Vercel custom provider reference preserving colons in model name", () => {
    expect(parseModelReference("vercel:p1:gemma3:4b")).toMatchObject({
      sdk: "vercel",
      providerId: "p1",
      modelName: "gemma3:4b",
      model: "gemma3:4b",
    });
  });

  it("rejects bare tier strings", () => {
    expect(() => parseModelReference("sonnet")).toThrow(/invalid model reference/i);
    expect(isValidModelReference("opus")).toBe(false);
  });

  it("rejects tier-looking prefixed values", () => {
    expect(() => parseModelReference("claude:sonnet")).toThrow(/tier aliases/i);
    expect(() => parseModelReference("openai:opus")).toThrow(/tier aliases/i);
  });

  it("rejects unknown sdk prefix", () => {
    expect(() => parseModelReference("bogus:x")).toThrow(/unknown sdk/i);
  });

  it("rejects malformed Vercel references", () => {
    expect(isValidModelReference("vercel:")).toBe(false);
    expect(isValidModelReference("vercel::model")).toBe(false);
    expect(isValidModelReference("vercel:p1:")).toBe(false);
  });
});
