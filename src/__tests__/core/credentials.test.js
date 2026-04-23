import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getBuiltinProviderAvailability } from "../../core/credentials.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"];

describe("getBuiltinProviderAvailability", () => {
  const saved = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("reports both providers unavailable when no keys are set", () => {
    const result = getBuiltinProviderAvailability();
    expect(result.claude.available).toBe(false);
    expect(result.openai.available).toBe(false);
    expect(result.claude.reason).toMatch(/ANTHROPIC_API_KEY/);
    expect(result.openai.reason).toMatch(/OPENAI_API_KEY/);
  });

  it("marks claude available when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const result = getBuiltinProviderAvailability();
    expect(result.claude.available).toBe(true);
    expect(result.claude.reason).toBe(null);
  });

  it("marks claude available when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
    const result = getBuiltinProviderAvailability();
    expect(result.claude.available).toBe(true);
  });

  it("marks claude available when ANTHROPIC_AUTH_TOKEN is set", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
    const result = getBuiltinProviderAvailability();
    expect(result.claude.available).toBe(true);
  });

  it("marks openai available when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const result = getBuiltinProviderAvailability();
    expect(result.openai.available).toBe(true);
    expect(result.openai.reason).toBe(null);
  });

  it("returns independent results per provider", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const result = getBuiltinProviderAvailability();
    expect(result.openai.available).toBe(true);
    expect(result.claude.available).toBe(false);
  });
});
