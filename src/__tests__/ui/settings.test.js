import { describe, expect, it } from "vitest";
import {
  minutesToMs,
  minutesValue,
  runtimePayload,
  settingsPayload,
} from "../../ui/src/routes/Settings.jsx";

describe("settings UI duration conversions", () => {
  it("formats millisecond timeout values as minutes", () => {
    expect(minutesValue(30 * 60 * 1000)).toBe("30");
    expect(minutesValue(120 * 1000)).toBe("2");
    expect(minutesValue(5000)).toBe("0.0833");
  });

  it("converts minute inputs back to integer milliseconds", () => {
    expect(minutesToMs("30")).toBe(1800000);
    expect(minutesToMs("2.5")).toBe(150000);
    expect(minutesToMs("0.0833")).toBe(4998);
  });

  it("keeps settings payload timeout fields in milliseconds", () => {
    const payload = settingsPayload({
      consolidation_hour: 3,
      consolidation_enabled: true,
      worker_timeout_ms: minutesToMs("30"),
      cancel_grace_ms: minutesToMs("0.0833"),
      journal_tail_lines: 80,
      kb_pinned_limit: 10,
      default_embedding_model: "",
    });
    expect(payload.worker_timeout_ms).toBe(1800000);
    expect(payload.cancel_grace_ms).toBe(4998);
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
  });
});
