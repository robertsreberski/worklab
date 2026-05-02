// Tool-result bloat containment.
//
// The runtime audit (docs/audits/automattic-benchmark-reset-runtime-audit.md)
// found that 28% of runs trip the context_bloat warning, with single
// tool_result payloads reaching 1.44 MB. This module caps tool_result
// payloads before they reach the model, persists the original bytes to disk,
// and substitutes a compact reference text so the agent can still cite the
// artifact.
//
// Phase 0 ships only constants and types. Phase 1 (R1) fills in
// `summarisePayload`.

export const MAX_TOOL_RESULT_BYTES = 262144;

export const BINARY_BLOAT_TOOLS = Object.freeze([
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_snapshot",
]);

export const DEFAULT_TOOL_BLOAT_CONFIG = Object.freeze({
  maxBytes: MAX_TOOL_RESULT_BYTES,
  binaryBloatTools: BINARY_BLOAT_TOOLS,
});
