import { describe, expect, it } from "vitest";
import {
  minutesToMs,
  minutesValue,
  runtimePayload,
  secondsToMs,
  secondsValue,
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
    });
    expect(payload.worker_timeout_ms).toBe(1800000);
    expect(payload.cancel_grace_ms).toBe(5000);
    expect(payload.slack_run_timeout_ms).toBe(120000);
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
});
