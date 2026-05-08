import { describe, expect, it } from "vitest";
import {
  claudeModelSupportsContextWindow,
  normalizeContextWindow,
  modelWithContextWindow,
} from "../../ai/runtime/context-windows.js";

describe("Claude context window helpers", () => {
  it("allows 1M context only for Opus 4.7 and Opus 4.6", () => {
    expect(claudeModelSupportsContextWindow("claude-opus-4-7", "1m")).toBe(true);
    expect(claudeModelSupportsContextWindow("claude-opus-4-6", "1m")).toBe(true);

    expect(claudeModelSupportsContextWindow("claude-sonnet-4-6", "1m")).toBe(false);
    expect(claudeModelSupportsContextWindow("claude-haiku-4-5-20251001", "1m")).toBe(false);
    expect(claudeModelSupportsContextWindow("gpt-5.5", "1m")).toBe(false);
  });

  it("normalizes unknown context-window values to default", () => {
    expect(normalizeContextWindow("1m")).toBe("1m");
    expect(normalizeContextWindow("default")).toBe("default");
    expect(normalizeContextWindow("")).toBe("default");
    expect(normalizeContextWindow("long")).toBe("default");
  });

  it("adds the Claude Code 1M suffix idempotently only when enabled", () => {
    expect(modelWithContextWindow("claude-opus-4-7", "1m")).toBe("claude-opus-4-7[1m]");
    expect(modelWithContextWindow("claude-opus-4-7[1m]", "1m")).toBe("claude-opus-4-7[1m]");
    expect(modelWithContextWindow("claude-opus-4-7", "default")).toBe("claude-opus-4-7");
  });
});
