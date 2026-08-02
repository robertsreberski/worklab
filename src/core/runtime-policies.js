// Maps Worklab's flat settings bag onto agent-runtime's typed run-policy
// objects (`toolLimits` / `compaction`).
//
// The runtime deprecated `options.settings` as a policy source: it is consumed
// only as a per-group fallback and emits one `deprecated_settings_option`
// runtime_warning per run when it is. Passing a typed object makes that group
// win wholesale and suppresses the warning.
//
// Omission is meaningful. A field left out lets the runtime resolve it
// adaptively against the model's real context window, which is why every value
// here is dropped when it is null/undefined rather than coerced to a number.
// The key maps mirror TOOL_LIMIT_SETTINGS_KEYS / COMPACTION_SETTINGS_KEYS in
// @mono-agent/agent-runtime/agent/compaction.js.

const TOOL_LIMIT_KEYS = {
  toolTextLimitChars: "agent_tool_text_limit_chars",
  bashOutputLimitChars: "agent_bash_output_limit_chars",
  mcpTextLimitChars: "agent_mcp_text_limit_chars",
  searchResultLimit: "agent_search_result_limit",
  imageInlineMaxBytes: "agent_image_inline_max_bytes",
  toolPayloadMaxBytes: "agent_tool_payload_max_bytes",
  mcpCallTimeoutMs: "agent_mcp_call_timeout_ms",
};

const COMPACTION_KEYS = {
  enabled: "agent_compaction_enabled",
  triggerRatio: "agent_compaction_trigger_ratio",
  keepRecentTokens: "agent_compaction_keep_recent_tokens",
  summaryMaxTokens: "agent_compaction_summary_max_tokens",
  minSavingsTokens: "agent_compaction_min_savings_tokens",
};

function pickPolicy(settings, keyMap) {
  const out = {};
  for (const [field, settingKey] of Object.entries(keyMap)) {
    const value = settings?.[settingKey];
    if (value !== null && value !== undefined) out[field] = value;
  }
  return out;
}

/**
 * @param {Object<string, *>} [settings] Worklab's resolved settings bag.
 * @returns {{toolLimits: Object<string, *>, compaction: Object<string, *>}}
 */
export function runtimePoliciesFromSettings(settings = {}) {
  return {
    toolLimits: pickPolicy(settings, TOOL_LIMIT_KEYS),
    compaction: pickPolicy(settings, COMPACTION_KEYS),
  };
}
