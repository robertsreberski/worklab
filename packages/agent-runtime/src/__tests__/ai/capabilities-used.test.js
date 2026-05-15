import { describe, expect, it } from "vitest";
import {
  UNKNOWN_CAPABILITY,
  buildCapabilitiesUsed,
  toolCompactionAppliedFromWarnings,
} from "../../ai/runtime/capabilities-used.js";

describe("buildCapabilitiesUsed", () => {
  it("emits sensible defaults: structured_output_enforced false, others null/[]", () => {
    const caps = buildCapabilitiesUsed();
    expect(caps).toEqual({
      prompt_cache_active: null,
      thinking_enabled: null,
      structured_output_enforced: false,
      subagent_invoked: null,
      mcp_servers_used: [],
      native_subagents_used: [],
      tool_compaction_applied: false,
      context_compaction_applied: null,
    });
  });

  it("preserves true/false in tristate fields and null for unknown values", () => {
    const caps = buildCapabilitiesUsed({
      promptCacheActive: true,
      thinkingEnabled: false,
      subagentInvoked: "yes",
      contextCompactionApplied: undefined,
    });
    expect(caps.prompt_cache_active).toBe(true);
    expect(caps.thinking_enabled).toBe(false);
    expect(caps.subagent_invoked).toBe(UNKNOWN_CAPABILITY);
    expect(caps.context_compaction_applied).toBe(UNKNOWN_CAPABILITY);
  });

  it("coerces structured_output_enforced and tool_compaction_applied to booleans", () => {
    const caps = buildCapabilitiesUsed({
      structuredOutputEnforced: "non-empty",
      toolCompactionApplied: 1,
    });
    expect(caps.structured_output_enforced).toBe(true);
    expect(caps.tool_compaction_applied).toBe(true);
  });

  it("filters non-string entries from MCP/native subagent lists", () => {
    const caps = buildCapabilitiesUsed({
      mcpServersUsed: ["a", null, undefined, "", "  b  ", 42],
      nativeSubagentsUsed: ["one", "two", { name: "no" }],
    });
    expect(caps.mcp_servers_used).toEqual(["a", "b"]);
    expect(caps.native_subagents_used).toEqual(["one", "two"]);
  });
});

describe("toolCompactionAppliedFromWarnings", () => {
  it("detects tool_payload_truncated warnings", () => {
    expect(toolCompactionAppliedFromWarnings([
      { warning_kind: "tool_payload_truncated", message: "..." },
      { warning_kind: "live_input_failed" },
    ])).toBe(true);
  });

  it("returns false on empty / non-array input", () => {
    expect(toolCompactionAppliedFromWarnings([])).toBe(false);
    expect(toolCompactionAppliedFromWarnings(null)).toBe(false);
    expect(toolCompactionAppliedFromWarnings("nope")).toBe(false);
  });
});
