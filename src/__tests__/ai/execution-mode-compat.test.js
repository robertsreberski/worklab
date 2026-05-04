import { describe, expect, it } from "vitest";
import {
  executionModeIncompatibilityReason,
  isModelCompatibleWithExecutionMode,
} from "../../ai/runtime/model-refs.js";

describe("executionModeIncompatibilityReason", () => {
  it("returns null for sdk execution mode (no restriction)", () => {
    expect(executionModeIncompatibilityReason("claude:claude-sonnet-4-6", "sdk")).toBeNull();
    expect(executionModeIncompatibilityReason("pi:openai:gpt-5", "sdk")).toBeNull();
    expect(executionModeIncompatibilityReason("pi:vercel-ai:claude-3-haiku", "sdk")).toBeNull();
  });

  it("returns null for any claude model under cli", () => {
    expect(executionModeIncompatibilityReason("claude:claude-sonnet-4-6", "cli")).toBeNull();
    expect(executionModeIncompatibilityReason("claude:claude-opus-4-7", "cli")).toBeNull();
    expect(executionModeIncompatibilityReason("claude:claude-haiku-4-5", "cli")).toBeNull();
  });

  it("returns null for pi:openai-codex models under cli", () => {
    expect(executionModeIncompatibilityReason("pi:openai-codex:gpt-5.5", "cli")).toBeNull();
    expect(executionModeIncompatibilityReason("pi:openai-codex:o4-mini", "cli")).toBeNull();
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
    expect(isModelCompatibleWithExecutionMode("pi:vercel-ai:foo", "cli")).toBe(false);
    expect(isModelCompatibleWithExecutionMode("pi:vercel-ai:foo", "sdk")).toBe(true);
  });
});
