import { describe, expect, it } from "vitest";
import { runtimePoliciesFromSettings } from "../../core/runtime-policies.js";
import { DEFAULT_SETTINGS } from "../../core/settings.js";

describe("runtime policy mapping", () => {
  it("maps Worklab settings onto the typed runtime policy objects", () => {
    const { toolLimits, compaction } = runtimePoliciesFromSettings({
      agent_tool_text_limit_chars: 1200,
      agent_bash_output_limit_chars: 1300,
      agent_mcp_text_limit_chars: 1400,
      agent_search_result_limit: 90,
      agent_image_inline_max_bytes: 100,
      agent_tool_payload_max_bytes: 262144,
      agent_mcp_call_timeout_ms: 5000,
      agent_compaction_enabled: false,
      agent_compaction_trigger_ratio: 0.5,
      agent_compaction_keep_recent_tokens: 8000,
      agent_compaction_summary_max_tokens: 4000,
      agent_compaction_min_savings_tokens: 2000,
    });

    expect(toolLimits).toEqual({
      toolTextLimitChars: 1200,
      bashOutputLimitChars: 1300,
      mcpTextLimitChars: 1400,
      searchResultLimit: 90,
      imageInlineMaxBytes: 100,
      toolPayloadMaxBytes: 262144,
      mcpCallTimeoutMs: 5000,
    });
    expect(compaction).toEqual({
      enabled: false,
      triggerRatio: 0.5,
      keepRecentTokens: 8000,
      summaryMaxTokens: 4000,
      minSavingsTokens: 2000,
    });
  });

  // Omission is what makes the runtime resolve a limit adaptively. Coercing a
  // null to a number here would silently pin it for every model.
  it("omits unset values instead of coercing them", () => {
    const { compaction } = runtimePoliciesFromSettings({
      agent_compaction_enabled: true,
      agent_compaction_trigger_ratio: null,
      agent_compaction_keep_recent_tokens: undefined,
    });

    expect(compaction).toEqual({ enabled: true });
    expect("triggerRatio" in compaction).toBe(false);
    expect("keepRecentTokens" in compaction).toBe(false);
  });

  // Both typed groups must be non-empty for Worklab's shipped defaults,
  // otherwise agent-runtime falls back to the deprecated `settings` bag and
  // emits a `deprecated_settings_option` warning on every run.
  it("produces both policy groups from the shipped defaults", () => {
    const { toolLimits, compaction } = runtimePoliciesFromSettings(DEFAULT_SETTINGS);

    expect(Object.keys(toolLimits).length).toBeGreaterThan(0);
    expect(compaction.enabled).toBe(true);
    expect(Object.values(compaction).every((value) => value != null)).toBe(true);
  });

  it("returns empty groups for an empty bag", () => {
    expect(runtimePoliciesFromSettings()).toEqual({ toolLimits: {}, compaction: {} });
  });
});
