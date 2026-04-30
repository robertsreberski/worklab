import { describe, expect, it } from "vitest";
import {
  mcpAvailabilitySummary,
  minutesToMs,
  minutesValue,
  runtimePayload,
  searchIndexMeta,
  secondsToMs,
  secondsValue,
  serviceStatusMeta,
  settingsPayload,
  slackRejectedSenderLabel,
  slackUserMatchesBot,
} from "../../ui/src/routes/Settings.jsx";

describe("settings UI duration conversions", () => {
  it("formats millisecond timeout values as minutes", () => {
    expect(minutesValue(30 * 60 * 1000)).toBe("30");
    expect(minutesValue(120 * 1000)).toBe("2");
    expect(minutesValue(5000)).toBe("0.0833");
  });

  it("formats cancel grace values as seconds", () => {
    expect(secondsValue(5000)).toBe("5");
    expect(secondsValue(2500)).toBe("2.5");
    expect(secondsValue(333)).toBe("0.33");
  });

  it("converts minute inputs back to integer milliseconds", () => {
    expect(minutesToMs("30")).toBe(1800000);
    expect(minutesToMs("2.5")).toBe(150000);
    expect(minutesToMs("0.0833")).toBe(4998);
  });

  it("converts second inputs back to integer milliseconds", () => {
    expect(secondsToMs("5")).toBe(5000);
    expect(secondsToMs("2.5")).toBe(2500);
    expect(secondsToMs("0.33")).toBe(330);
  });

  it("keeps settings payload timeout fields in milliseconds", () => {
    const payload = settingsPayload({
      consolidation_hour: 3,
      consolidation_enabled: true,
      worker_timeout_ms: minutesToMs("30"),
      cancel_grace_ms: secondsToMs("5"),
      journal_tail_lines: 80,
      kb_pinned_limit: 10,
      default_embedding_model: "",
      slack_run_timeout_ms: minutesToMs("2"),
      assistant_run_timeout_ms: minutesToMs("5"),
      assistant_max_turns: 48,
      delegation_enabled: false,
      delegation_max_depth: 2,
      delegation_max_children_per_round: 7,
      delegation_max_parallel_children: 4,
      delegation_auto_run_children: false,
      agent_compaction_enabled: true,
      agent_compaction_trigger_ratio: 0.7,
      agent_compaction_keep_recent_tokens: 32000,
      agent_compaction_summary_max_tokens: 12000,
      agent_compaction_min_savings_tokens: 18000,
      agent_tool_payload_compaction_trigger_chars: 0,
      agent_tool_prune_trigger_tokens: 36000,
      agent_tool_text_limit_chars: 18000,
      agent_bash_output_limit_chars: 22000,
      agent_mcp_text_limit_chars: 16000,
      agent_search_result_limit: 90,
      agent_image_inline_max_bytes: 200000,
      agent_mcp_call_timeout_ms: secondsToMs("90"),
      agent_recovery_continuation_limit: 4,
      agent_provider_recovery_enabled: true,
      agent_provider_recovery_base_delay_ms: secondsToMs("45"),
    });
    expect(payload.worker_timeout_ms).toBe(1800000);
    expect(payload.cancel_grace_ms).toBe(5000);
    expect(payload.slack_run_timeout_ms).toBe(120000);
    expect(payload.assistant_run_timeout_ms).toBe(300000);
    expect(payload.assistant_max_turns).toBe(48);
    expect(payload.delegation_enabled).toBe(false);
    expect(payload.delegation_max_depth).toBe(2);
    expect(payload.delegation_max_children_per_round).toBe(7);
    expect(payload.delegation_max_parallel_children).toBe(4);
    expect(payload.delegation_auto_run_children).toBe(false);
    expect(payload.agent_compaction_trigger_ratio).toBe(0.7);
    expect(payload.agent_compaction_keep_recent_tokens).toBe(32000);
    expect(payload.agent_compaction_min_savings_tokens).toBe(18000);
    expect(payload.agent_tool_payload_compaction_trigger_chars).toBe(0);
    expect(payload.agent_tool_prune_trigger_tokens).toBe(36000);
    expect(payload.agent_tool_text_limit_chars).toBe(18000);
    expect(payload.agent_search_result_limit).toBe(90);
    expect(payload.agent_mcp_call_timeout_ms).toBe(90000);
    expect(payload.agent_recovery_continuation_limit).toBe(4);
    expect(payload.agent_provider_recovery_enabled).toBe(true);
    expect(payload.agent_provider_recovery_base_delay_ms).toBe(45000);
  });

  it("keeps runtime idle warning payload in milliseconds", () => {
    const payload = runtimePayload({
      host: "127.0.0.1",
      port: 7878,
      workspace: "/tmp/workspace",
      logLevel: "info",
      timezone: "",
      runIdleWarningMs: minutesToMs("2"),
      logInlineLimit: 12000,
    });
    expect(payload.runIdleWarningMs).toBe(120000);
    expect(payload).not.toHaveProperty("slackBotToken");
  });

  it("detects when the configured Slack user is the bot user", () => {
    expect(slackUserMatchesBot({ slack_user_id: "UBOT" }, { bot_user_id: "UBOT" })).toBe(true);
    expect(slackUserMatchesBot({ slack_user_id: "UHUMAN" }, { bot_user_id: "UBOT" })).toBe(false);
  });

  it("formats the last rejected Slack sender for status display", () => {
    expect(slackRejectedSenderLabel({
      last_rejected: { reason: "wrong_dm_user", user: "U02NXLR1NPL" },
    })).toBe("wrong_dm_user / U02NXLR1NPL");
    expect(slackRejectedSenderLabel({})).toBe("-");
  });

  it("summarizes runtime service status for overview cards", () => {
    expect(serviceStatusMeta(null)).toEqual({ status: "error", label: "Unavailable" });
    expect(serviceStatusMeta({ restartRequired: true })).toEqual({ status: "running", label: "Restart pending" });
    expect(serviceStatusMeta({ service: { installed: true, platform: "launchd" } })).toEqual({
      status: "enabled",
      label: "Installed (launchd)",
    });
  });

  it("summarizes search index health for the settings overview", () => {
    expect(searchIndexMeta(null)).toEqual({ status: "disabled", label: "Unknown" });
    expect(searchIndexMeta({ errors: 2, ready: true, model: "openai:text-embedding-3-small" })).toEqual({ status: "error", label: "Has errors" });
    expect(searchIndexMeta({ errors: 0, ready: false, model: "openai:text-embedding-3-small" })).toEqual({ status: "running", label: "Paused" });
    expect(searchIndexMeta({ errors: 0, ready: true, model: "openai:text-embedding-3-small" })).toEqual({ status: "enabled", label: "Ready" });
  });

  it("summarizes MCP availability without counting draft rows as unavailable", () => {
    expect(mcpAvailabilitySummary({
      servers: [
        { source: "builtin", available: true },
        { source: "user", available: false },
      ],
    }, [{ name: "external" }, { name: "" }])).toEqual({
      status: "error",
      label: "1 unavailable",
      builtin: 1,
      user: 2,
      unavailable: 1,
    });
    expect(mcpAvailabilitySummary({ config_error: "bad json", servers: [] }, [])).toEqual({
      status: "error",
      label: "Config error",
      builtin: 0,
      user: 0,
      unavailable: 0,
    });
  });
});
