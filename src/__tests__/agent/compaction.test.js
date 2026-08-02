import { describe, expect, it } from "vitest";
import {
  isLikelyContextTermination,
  resolveAgentCompactionPolicy,
} from "@mono-agent/agent-runtime/agent/compaction.js";

describe("agent compaction policy", () => {
  it("uses pruning-first defaults for long sessions", () => {
    const policy = resolveAgentCompactionPolicy({}, { contextWindow: 128000 });

    expect(policy.triggerRatio).toBe(0.7);
    expect(policy.compactionMinSavingsTokens).toBe(12800);
    expect(policy.searchResultLimit).toBe(100);
    // 0.15.1 deleted toolPayloadCompactionTriggerChars / toolPruneTriggerTokens:
    // they were resolved onto the policy but never read, and had no supported
    // typed path. Worklab dropped the settings that fed them.
    expect(policy).not.toHaveProperty("toolPayloadCompactionTriggerChars");
    expect(policy).not.toHaveProperty("toolPruneTriggerTokens");
  });

  // Worklab leaves the four compaction limits unset so the runtime scales them
  // to the model actually serving the request; a bigger window must widen the
  // token budgets rather than reuse a fixed 128k-shaped policy.
  it("scales the unset token budgets to the model context window", () => {
    const small = resolveAgentCompactionPolicy({}, { contextWindow: 128000 });
    const large = resolveAgentCompactionPolicy({}, { contextWindow: 1000000 });

    expect(small).toMatchObject({
      triggerTokens: 89600,
      keepRecentTokens: 12800,
      summaryMaxTokens: 5120,
    });
    expect(large).toMatchObject({
      triggerTokens: 700000,
      keepRecentTokens: 20000,
      summaryMaxTokens: 12000,
    });
  });

  it("normalizes Worklab settings into runtime compaction limits", () => {
    const policy = resolveAgentCompactionPolicy({
      agent_compaction_trigger_ratio: 0.2,
      agent_compaction_keep_recent_tokens: 4000,
      agent_compaction_summary_max_tokens: 1000,
      agent_compaction_min_savings_tokens: 0,
      agent_tool_text_limit_chars: 1200,
      agent_image_inline_max_bytes: 100,
    }, { contextWindow: 32000 });

    expect(policy).toMatchObject({
      contextWindow: 32000,
      triggerRatio: 0.2,
      triggerTokens: 6400,
      keepRecentTokens: 4000,
      summaryMaxTokens: 1000,
      compactionMinSavingsTokens: 0,
      toolTextLimitChars: 1200,
      imageInlineMaxBytes: 100,
    });
  });

  it("classifies context-pressure terminations from runtime diagnostics", () => {
    expect(isLikelyContextTermination("stream terminated", {
      context_compactions: 1,
    })).toBe(true);
    expect(isLikelyContextTermination("stream terminated", {
      context_tokens_estimate: 9000,
      context_compaction_trigger_tokens: 10000,
    })).toBe(true);
    expect(isLikelyContextTermination("ordinary provider error", {
      context_compactions: 1,
    })).toBe(false);
  });
});
