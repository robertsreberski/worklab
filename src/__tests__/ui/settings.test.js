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
    });
    expect(payload.worker_timeout_ms).toBe(1800000);
    expect(payload.cancel_grace_ms).toBe(5000);
    expect(payload.slack_run_timeout_ms).toBe(120000);
    expect(payload.assistant_run_timeout_ms).toBe(300000);
    expect(payload.assistant_max_turns).toBe(48);
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
