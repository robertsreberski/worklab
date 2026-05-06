import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mcpAvailabilitySummary,
  mcpServerFromRow,
  minutesToMs,
  minutesValue,
  notificationDescription,
  notificationDiagnosticText,
  notificationEnableToast,
  notificationStatus,
  runtimePayload,
  searchIndexMeta,
  secondsToMs,
  secondsValue,
  serviceStatusMeta,
  settingsPayload,
  slackRejectedSenderLabel,
  slackUserMatchesBot,
} from "../../ui/src/routes/settings/helpers.js";

const settingsSourcePath = resolve(import.meta.dirname, "../../ui/src/routes/Settings.jsx");

describe("settings UI duration conversions", () => {
  it("keeps Run limits labels compact because the controls already show units", () => {
    const source = readFileSync(settingsSourcePath, "utf8");

    expect(source).toContain('label="Worker timeout"');
    expect(source).toContain('label="Cancel grace"');
    expect(source).not.toContain('label="Worker timeout (minutes)"');
    expect(source).not.toContain('label="Cancel grace (seconds)"');
  });

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
      agent_budget_soft_turns: 400,
      agent_budget_hard_turns: 800,
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
      agent_verification_adjudicator_mode: "ollama",
      agent_verification_adjudicator_model: "gpt-oss-safeguard:20b",
      agent_verification_adjudicator_base_url: "http://127.0.0.1:11434",
      agent_verification_adjudicator_timeout_ms: secondsToMs("45"),
      planning_harness: "execplan_deep",
      planning_tool_policy: "read_only_no_shell",
      agent_learning_enabled: false,
      agent_learning_injected_limit: 12,
      agent_learning_auto_approve_threshold: 0.7,
    });
    expect(payload.worker_timeout_ms).toBe(1800000);
    expect(payload.cancel_grace_ms).toBe(5000);
    expect(payload.slack_run_timeout_ms).toBe(120000);
    expect(payload.assistant_run_timeout_ms).toBe(300000);
    expect(payload.assistant_max_turns).toBe(48);
    expect(payload.agent_budget_soft_turns).toBe(400);
    expect(payload.agent_budget_hard_turns).toBe(800);
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
    expect(payload.agent_verification_adjudicator_mode).toBe("ollama");
    expect(payload.agent_verification_adjudicator_model).toBe("gpt-oss-safeguard:20b");
    expect(payload.agent_verification_adjudicator_base_url).toBe("http://127.0.0.1:11434");
    expect(payload.agent_verification_adjudicator_timeout_ms).toBe(45000);
    expect(payload.planning_harness).toBe("execplan_deep");
    expect(payload.planning_tool_policy).toBe("read_only_no_shell");
    expect(payload.agent_learning_enabled).toBe(false);
    expect(payload).not.toHaveProperty(["agent_learning", "backend"].join("_"));
    expect(payload.agent_learning_injected_limit).toBe(12);
    expect(payload.agent_learning_auto_approve_threshold).toBe(0.7);
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

  it("summarizes browser and PWA notification modes", () => {
    expect(notificationStatus({ mode: "browser", supported: true, permission: "granted", enabled: true })).toEqual({ status: "enabled", label: "On" });
    expect(notificationDescription({ mode: "browser", supported: true, permission: "granted", enabled: true })).toBe("Task run starts, completions, and errors in background tabs.");
    expect(notificationStatus({ mode: "pwa", supported: true, permission: "default", enabled: false })).toEqual({ status: "disabled", label: "PWA off" });
    expect(notificationDescription({ mode: "pwa", supported: true, permission: "default", enabled: false })).toBe("Push notifications for task runs, even when Worklab is closed.");
    expect(notificationStatus({ mode: "pwa", supported: true, permission: "denied", enabled: false })).toEqual({ status: "error", label: "Needs settings" });
    expect(notificationDescription({ mode: "pwa", supported: true, permission: "denied", enabled: false })).toBe("Enable notifications for Worklab in system settings, then turn this on again.");
    expect(notificationStatus({ mode: "pwa", supported: false, blockingReason: "install_required" })).toEqual({ status: "disabled", label: "Install required" });
    expect(notificationDescription({ mode: "pwa", supported: false, blockingReason: "install_required" })).toBe("Install Worklab to the Home Screen and open it from the app icon.");
    expect(notificationDescription({ mode: "pwa", supported: false, blockingReason: "push_api_unavailable" })).toBe("This browser does not expose Web Push for this Worklab app.");
  });

  it("maps PWA notification enable results to actionable toast copy", () => {
    expect(notificationEnableToast({ mode: "pwa", enabled: true, reason: "registered" })).toEqual({ message: "Notifications enabled.", variant: "success" });
    expect(notificationEnableToast({ mode: "pwa", enabled: false, reason: "permission_denied" })).toEqual({
      message: "Notifications are blocked for Worklab. Enable them in system settings, then turn this on again.",
      variant: "error",
    });
    expect(notificationEnableToast({ mode: "pwa", enabled: false, reason: "permission_dismissed" })).toEqual({
      message: "Notification permission was not granted. Turn Notifications on again to retry the prompt.",
      variant: "info",
    });
    expect(notificationEnableToast({ mode: "pwa", enabled: false, reason: "missing_public_key" })).toEqual({
      message: "Push notifications are not configured on this Worklab server.",
      variant: "error",
    });
    expect(notificationEnableToast({ mode: "pwa", enabled: false, reason: "subscription_failed", error: "subscribe failed" })).toEqual({
      message: "Device registration failed: subscribe failed",
      variant: "error",
    });
    expect(notificationEnableToast({ mode: "pwa", enabled: false, reason: "install_required" })).toEqual({
      message: "Install Worklab to the Home Screen and open it from the app icon.",
      variant: "error",
    });
  });

  it("summarizes notification diagnostics for Settings", () => {
    expect(notificationDiagnosticText({
      mode: "pwa",
      permission: "default",
      blockingReason: null,
      diagnostics: {
        secure: true,
        standalone: true,
        serviceWorker: true,
        pushManager: true,
      },
    }, { notifications: { pwa: { activeSubscriptions: 0 } } })).toBe("Mode PWA / permission default / standalone yes / secure yes / service worker yes / Push API yes / server subscriptions 0");
    expect(notificationDiagnosticText({
      mode: "pwa",
      permission: "denied",
      blockingReason: "install_required",
      diagnostics: {
        secure: true,
        standalone: false,
        serviceWorker: true,
        pushManager: false,
      },
    })).toBe("Mode PWA / install required / permission denied / standalone no / secure yes / service worker yes / Push API no / server subscriptions -");
    expect(notificationDiagnosticText({
      mode: "browser",
      permission: "granted",
    })).toBe("Mode Browser / permission granted");
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

  it("builds a single MCP server config from a settings row for health checks", () => {
    expect(mcpServerFromRow({
      name: "local_tools",
      transport: "stdio",
      command: "/usr/bin/node",
      argsText: "server.js\n--flag",
      envText: '{"TOKEN":"x"}',
    })).toEqual({
      name: "local_tools",
      config: {
        command: "/usr/bin/node",
        args: ["server.js", "--flag"],
        env: { TOKEN: "x" },
      },
    });
    expect(mcpServerFromRow({
      name: "http_tools",
      transport: "http",
      url: "http://localhost:3000/mcp",
      headersText: '{"Authorization":"Bearer token"}',
    })).toEqual({
      name: "http_tools",
      config: {
        type: "http",
        url: "http://localhost:3000/mcp",
        headers: { Authorization: "Bearer token" },
      },
    });
  });

  it("surfaces MCP row validation errors before health checks", () => {
    expect(() => mcpServerFromRow({ name: "", transport: "stdio", command: "/usr/bin/node" })).toThrow(/name is required/i);
    expect(() => mcpServerFromRow({ name: "bad", transport: "stdio", command: "" })).toThrow(/requires an absolute command path/i);
    expect(() => mcpServerFromRow({ name: "bad", transport: "http", url: "" })).toThrow(/requires a URL/i);
  });
});
