import { describe, expect, it } from "vitest";
import {
  executionModeIncompatibilityReason,
  isModelCompatibleWithExecutionMode,
  parseRuntimeModelReference,
} from "../../ai/runtime/model-refs.js";

describe("parseRuntimeModelReference (opencode)", () => {
  it("parses opencode:<providerID>:<modelID> into sdk/provider/model", () => {
    expect(parseRuntimeModelReference("opencode:github-copilot:gpt-5.1")).toEqual({
      sdk: "opencode",
      provider: "github-copilot",
      model: "gpt-5.1",
      reference: "opencode:github-copilot:gpt-5.1",
    });
  });

  it("keeps slashes in the model id (only the first colon separates provider/model)", () => {
    expect(parseRuntimeModelReference("opencode:openrouter:anthropic/claude-3.5-sonnet")).toEqual({
      sdk: "opencode",
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      reference: "opencode:openrouter:anthropic/claude-3.5-sonnet",
    });
  });

  it("rejects an opencode reference missing the model id", () => {
    expect(() => parseRuntimeModelReference("opencode:github-copilot")).toThrow(/opencode model reference/i);
  });
});

describe("executionModeIncompatibilityReason", () => {
  it("returns null for sdk execution mode (no restriction)", () => {
    expect(executionModeIncompatibilityReason("claude:claude-sonnet-4-6", "sdk")).toBeNull();
    expect(executionModeIncompatibilityReason("pi:openai:gpt-5", "sdk")).toBeNull();
    expect(executionModeIncompatibilityReason("pi:vercel-ai:claude-3-haiku", "sdk")).toBeNull();
    expect(executionModeIncompatibilityReason("codex:gpt-5.5", "sdk"))
      .toMatch(/Codex CLI.*requires CLI/i);
  });

  it("returns null for any claude model under cli", () => {
    expect(executionModeIncompatibilityReason("claude:claude-sonnet-4-6", "cli")).toBeNull();
    expect(executionModeIncompatibilityReason("claude:claude-opus-4-7", "cli")).toBeNull();
    expect(executionModeIncompatibilityReason("claude:claude-haiku-4-5", "cli")).toBeNull();
  });

  it("returns null for codex models under cli", () => {
    expect(executionModeIncompatibilityReason("codex:gpt-5.5", "cli")).toBeNull();
    expect(executionModeIncompatibilityReason("codex:gpt-5.4-mini", "cli")).toBeNull();
  });

  it("treats opencode as CLI-only", () => {
    expect(executionModeIncompatibilityReason("opencode:github-copilot:gpt-5.1", "cli")).toBeNull();
    expect(executionModeIncompatibilityReason("opencode:github-copilot:gpt-5.1", "sdk"))
      .toMatch(/OpenCode.*requires CLI/i);
  });

  it("rejects pi:openai-codex models under cli because they are SDK-only", () => {
    expect(executionModeIncompatibilityReason("pi:openai-codex:gpt-5.5", "cli"))
      .toMatch(/openai-codex.*SDK/i);
    expect(executionModeIncompatibilityReason("pi:openai-codex:o4-mini", "cli"))
      .toMatch(/openai-codex.*SDK/i);
  });

  it("rejects non-codex pi providers under cli with a reason naming the provider", () => {
    expect(executionModeIncompatibilityReason("pi:openai:gpt-5", "cli"))
      .toMatch(/openai.*only runs under SDK/);
    expect(executionModeIncompatibilityReason("pi:vercel-ai:claude-3-haiku", "cli"))
      .toMatch(/vercel-ai.*only runs under SDK/);
    expect(executionModeIncompatibilityReason("pi:my-custom:gpt-5", "cli"))
      .toMatch(/my-custom.*only runs under SDK/);
  });

  it("returns null for unparseable refs (defers to upstream validation)", () => {
    expect(executionModeIncompatibilityReason("nonsense", "cli")).toBeNull();
    expect(executionModeIncompatibilityReason("", "cli")).toBeNull();
  });

  it("isModelCompatibleWithExecutionMode mirrors the predicate", () => {
    expect(isModelCompatibleWithExecutionMode("claude:claude-sonnet-4-6", "cli")).toBe(true);
    expect(isModelCompatibleWithExecutionMode("codex:gpt-5.5", "cli")).toBe(true);
    expect(isModelCompatibleWithExecutionMode("codex:gpt-5.5", "sdk")).toBe(false);
    expect(isModelCompatibleWithExecutionMode("pi:openai-codex:gpt-5.5", "cli")).toBe(false);
    expect(isModelCompatibleWithExecutionMode("pi:vercel-ai:foo", "cli")).toBe(false);
    expect(isModelCompatibleWithExecutionMode("pi:vercel-ai:foo", "sdk")).toBe(true);
  });
});
