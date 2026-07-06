import { describe, expect, it } from "vitest";
import {
  isLikelyContextTermination,
  resolveAgentCompactionPolicy,
} from "@mono-agent/agent-runtime/agent/compaction.js";

describe("agent compaction policy", () => {
  it("uses pruning-first defaults for long sessions", () => {
    const policy = resolveAgentCompactionPolicy({}, { contextWindow: 128000 });

    expect(policy.triggerRatio).toBe(0.85);
    expect(policy.toolPayloadCompactionTriggerChars).toBe(0);
    expect(policy.toolPruneTriggerTokens).toBe(40000);
    expect(policy.compactionMinSavingsTokens).toBe(20000);
    expect(policy.searchResultLimit).toBe(100);
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
