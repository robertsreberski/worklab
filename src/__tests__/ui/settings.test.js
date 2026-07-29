import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mcpAvailabilitySummary,
  mcpRowsFromServers,
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
  SETTINGS_SECTION_LINKS,
  slackRejectedSenderLabel,
  slackUserMatchesBot,
  updateInstallDescription,
  updateStatusMeta,
  updateVersionDetail,
} from "../../ui/src/routes/settings/helpers.js";

const appShellSourcePath = resolve(import.meta.dirname, "../../ui/src/components/AppShell.jsx");
const settingsSourcePath = resolve(import.meta.dirname, "../../ui/src/routes/Settings.jsx");
const settingsHelpersSourcePath = resolve(import.meta.dirname, "../../ui/src/routes/settings/helpers.js");
const settingsShellSourcePath = resolve(import.meta.dirname, "../../ui/src/routes/settings/SettingsShell.jsx");
const settingsStylesPath = resolve(import.meta.dirname, "../../ui/src/styles.css");
const providersSourcePath = resolve(import.meta.dirname, "../../ui/src/routes/settings/ProvidersTab.jsx");
const aboutHeroPath = resolve(import.meta.dirname, "../../ui/public/about/worklab-about-hero.png");

function cssRule(styles, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]+)\\}`))?.groups?.body || "";
}

describe("settings UI duration conversions", () => {
  it("keeps Run limits labels compact because the controls already show units", () => {
    const source = readFileSync(settingsSourcePath, "utf8");

    expect(source).toContain('label="Worker timeout"');
    expect(source).toContain('label="Cancel grace"');
    expect(source).not.toContain('label="Worker timeout (minutes)"');
    expect(source).not.toContain('label="Cancel grace (seconds)"');
  });

  it("drives settings overview cards and section nav from the same section map", () => {
    const source = readFileSync(settingsSourcePath, "utf8");
    const helpersSource = readFileSync(settingsHelpersSourcePath, "utf8");
    const sectionIds = SETTINGS_SECTION_LINKS.map((item) => item.id);

    expect(sectionIds).toEqual([
      "settings-runtime",
      "settings-execution",
      "settings-notifications",
      "settings-assistant",
      "settings-slack",
      "settings-search",
      "settings-tools",
    ]);
    expect(helpersSource).toContain("export const SETTINGS_SECTION_LINKS");
    expect(source).toContain("overviewCards.map");
    expect(source).toContain("SETTINGS_SECTION_LINKS.map");
    expect(source).toContain("settingsOverviewCards({");
    expect(source).toContain("active={activeSectionId === card.targetId}");
    expect(source).toContain('aria-current={activeSectionId === item.id ? "location" : undefined}');
  });

  it("keeps the in-page Settings section nav sticky, labeled on desktop, and compact on mobile", () => {
    const source = readFileSync(settingsSourcePath, "utf8");
    const styles = readFileSync(settingsStylesPath, "utf8");

    expect(source).toContain("iconLeft={<Icon name={item.icon} size={18} />}");
    expect(source).toContain("{item.label}");
    expect(source).toContain('title={item.label}');
    expect(source).toContain('aria-label={item.label}');
    expect(source).toContain('class="settings-route-general"');
    expect(styles).toMatch(/\.settings-section-nav\s*\{[^}]*position:\s*sticky/);
    expect(styles).toMatch(/\.settings-section-nav\s*\{[^}]*top:\s*calc\(var\(--sp-2\) \+ var\(--mobile-safe-top\)\)/);
    expect(styles).toMatch(/\.settings-section-nav\s*\{[^}]*width:\s*100%/);
    expect(styles).toMatch(/\.settings-section-nav\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(styles).toMatch(/\.settings-route-shell\.settings-route-general\s+\.settings-route-content\s*\{[^}]*flex:\s*0 0 auto/);
    expect(styles).toMatch(/\.settings-route-shell\.settings-route-general\s+\.settings-route-content\s*\{[^}]*min-height:\s*auto/);
    expect(styles).toMatch(/\.settings-section-nav\s+\.button\s*\{[^}]*min-height:\s*40px/);
    expect(styles).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.settings-section-nav\s+\.button-label\s*\{[^}]*display:\s*none/);
    expect(styles).not.toContain(".settings-section-nav-label");
  });

  it("keeps dense Settings layout surfaces grouped and width-safe", () => {
    const source = readFileSync(settingsSourcePath, "utf8");
    const styles = readFileSync(settingsStylesPath, "utf8");

    expect(source).toContain('class="settings-note-grid settings-note-grid-paths"');
    expect(source).toContain('class="settings-planning-grid"');
    expect(source).toContain('<AdvancedSettings summary="Budgets and recovery" count={6}>');
    expect(source).toContain('label="Codex transport"');
    for (const group of [
      "Delegation",
      "Run turn budget",
      "Context compaction",
      "Tool output limits",
      "Recovery and verification",
    ]) {
      expect(source).toContain(`ControlGroup title="${group}"`);
    }
    expect(styles).toContain(".settings-page .select");
    expect(styles).toContain(".ds-control-groups");
    expect(styles).toContain(".ds-control-grid");
    expect(styles).toContain(".settings-note-grid-paths");
  });

  it("uses one aligned route shell for Settings, Providers, and About", () => {
    const source = readFileSync(settingsSourcePath, "utf8");
    const shellSource = readFileSync(settingsShellSourcePath, "utf8");
    const styles = readFileSync(settingsStylesPath, "utf8");
    const pageRule = cssRule(styles, ".settings-page");
    const shellRule = cssRule(styles, ".settings-route-shell");

    expect(shellSource).toContain("function SettingsTabs");
    expect(shellSource).toContain("function SettingsRouteShell");
    expect(shellSource).toContain('class="settings-route-content"');
    expect(source).toContain('title="Providers"');
    expect(source).toContain('title="About Worklab"');
    expect(source).not.toContain('<div class="ds-page-head">');
    expect(styles).toContain(".settings-route-shell");
    expect(styles).toContain(".settings-route-content");
    expect(styles).toContain(".settings-about-grid");
    expect(pageRule).not.toContain("max-width: 1200px");
    expect(shellRule).toContain("max-width: none");
    expect(shellRule).not.toContain("margin: 0 auto");
  });

  it("aligns the provider edit header and body inside Settings", () => {
    const source = readFileSync(providersSourcePath, "utf8");
    const styles = readFileSync(settingsStylesPath, "utf8");
    const providerToolbarRule = cssRule(styles, ".provider-pane-layout .resource-toolbar");

    expect(source).toContain('class="resource-list-layout provider-pane-layout"');
    expect(source).toContain('class="provider-detail-head"');
    expect(source).toContain('actionsClass="provider-detail-actions"');
    expect(styles).toContain(".provider-pane-layout");
    expect(styles).toContain(".settings-route-providers");
    expect(styles).toContain(".provider-detail-head");
    expect(styles).toContain(".provider-detail-body");
    expect(styles).toContain(".provider-editor-layout");
    expect(providerToolbarRule).not.toContain("padding: var(--sp-1) var(--sp-4) var(--sp-2)");
    expect(providerToolbarRule).not.toContain("background: color-mix(in srgb, var(--surface) 42%, transparent)");
  });

  it("shows stored provider API keys without returning the secret", () => {
    const source = readFileSync(providersSourcePath, "utf8");
    const styles = readFileSync(settingsStylesPath, "utf8");
    const statusRule = cssRule(styles, ".provider-api-key-status");

    expect(source).toContain("provider.has_api_key");
    expect(source).toContain("provider-api-key-status");
    expect(source).toContain("Stored API key configured");
    expect(source).toContain("Enter a new key to replace the stored key");
    expect(source).toContain("api_key: provider.api_key || undefined");
    expect(statusRule).toContain("display: inline-flex");
    expect(statusRule).toContain("border");
  });

  it("keeps provider list rows readable when the list pane is narrow", () => {
    const styles = readFileSync(settingsStylesPath, "utf8");
    const rowRule = cssRule(styles, ".provider-pane-row");
    const titleRule = cssRule(styles, ".provider-pane-row .pane-row-title");
    const metaRule = cssRule(styles, ".provider-pane-row .pane-row-meta");
    const summaryRule = cssRule(styles, ".provider-pane-row .pane-row-summary");
    const chipRule = cssRule(styles, ".provider-pane-row .resource-row-chip");

    expect(rowRule).toContain("grid-template-columns");
    expect(rowRule).toContain("minmax(0, 1fr)");
    expect(rowRule).toContain("minmax(0, 96px)");
    expect(titleRule).toContain("-webkit-line-clamp: 2");
    expect(metaRule).toContain("min-width: 0");
    expect(summaryRule).toContain("font-size: var(--text-xs)");
    expect(chipRule).toContain("max-width");
  });

  it("presents About as a polished visual surface with a project-local generated asset", () => {
    const source = readFileSync(settingsShellSourcePath, "utf8");
    const styles = readFileSync(settingsStylesPath, "utf8");

    expect(source).toContain('class="settings-about-hero"');
    expect(source).toContain('src="/about/worklab-about-hero.png"');
    expect(source).toContain('class="settings-about-stat-grid"');
    expect(styles).toContain(".settings-about-hero");
    expect(styles).toContain(".settings-about-visual");
    expect(styles).toContain(".settings-about-stat-grid");
    expect(existsSync(aboutHeroPath)).toBe(true);
  });

  it("scopes the New Task keyboard hint spacing to the Commander CTA", () => {
    const styles = readFileSync(settingsStylesPath, "utf8");

    expect(styles).toContain(".commander-new-task-inline .kbd");
    expect(styles).toMatch(/\.commander-new-task-inline\s+\.kbd\s*\{[^}]*margin-left:\s*var\(--sp-1\)/);
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
      agent_pi_codex_transport: "websocket",
      agent_verification_adjudicator_mode: "on",
      agent_verification_adjudicator_model: "provider:ollama-local:gpt-oss-safeguard:20b",
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
    expect(payload.agent_pi_codex_transport).toBe("websocket");
    expect(payload.agent_verification_adjudicator_mode).toBe("on");
    expect(payload.agent_verification_adjudicator_model).toBe("provider:ollama-local:gpt-oss-safeguard:20b");
    expect(payload).not.toHaveProperty("agent_verification_adjudicator_base_url");
    expect(payload.agent_verification_adjudicator_timeout_ms).toBe(45000);
    expect(payload.planning_harness).toBe("execplan_deep");
    expect(payload.planning_tool_policy).toBe("read_only_no_shell");
    expect(payload.agent_learning_enabled).toBe(false);
    expect(payload).not.toHaveProperty(["agent_learning", "backend"].join("_"));
    expect(payload.agent_learning_injected_limit).toBe(12);
    expect(payload.agent_learning_auto_approve_threshold).toBe(0.7);
  });

  it("defaults the Pi Codex transport payload to SSE", () => {
    expect(settingsPayload({}).agent_pi_codex_transport).toBe("sse");
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

  it("summarizes app update status and install mode for Settings", () => {
    expect(updateStatusMeta(null)).toEqual({ status: "disabled", label: "Unknown" });
    expect(updateStatusMeta({ update_available: true })).toEqual({ status: "running", label: "Update available" });
    expect(updateStatusMeta({ status: "local_newer" })).toEqual({ status: "enabled", label: "Local newer" });
    expect(updateStatusMeta({ status: "current" })).toEqual({ status: "enabled", label: "Current" });
    expect(updateStatusMeta({ status: "unknown", error: "registry timeout" })).toEqual({ status: "error", label: "Check failed" });

    expect(updateVersionDetail({
      package: { current_version: "0.1.3", latest_version: "0.2.0" },
    })).toBe("0.1.3 -> 0.2.0");
    expect(updateInstallDescription({ mode: "source_checkout", supported: false })).toBe("Source checkout; update from git or npm manually.");
    expect(updateInstallDescription({ mode: "global_npm", supported: true })).toBe("Global npm install; one-click update is available.");
  });

  it("wires a global app update banner from AppShell", () => {
    const source = readFileSync(appShellSourcePath, "utf8");
    const hookSource = readFileSync(
      resolve(import.meta.dirname, "../../ui/src/routes/settings/use-update-status.js"),
      "utf8",
    );

    expect(source).toContain("function UpdateBanner");
    expect(source).toContain("useUpdateStatus");
    expect(source).toContain("worklab.updateBannerDismissedVersion");
    expect(hookSource).toContain("api.getUpdate");
    expect(hookSource).toContain("api.applyUpdate");
  });

  it("summarizes search index health for the settings overview", () => {
    expect(searchIndexMeta(null)).toEqual({ status: "disabled", label: "Unknown" });
    expect(searchIndexMeta({ errors: 2, ready: true, model: "openai:text-embedding-3-small" })).toEqual({ status: "error", label: "Has errors" });
    expect(searchIndexMeta({ errors: 0, ready: false, model: "openai:text-embedding-3-small" })).toEqual({ status: "running", label: "Paused" });
    expect(searchIndexMeta({ errors: 0, ready: true, model: "openai:text-embedding-3-small" })).toEqual({ status: "enabled", label: "Ready" });
  });

  it("renders the resolved embedding label while retaining the raw reference", () => {
    const source = readFileSync(settingsSourcePath, "utf8");
    expect(source).toContain("indexStatus?.model_label || indexStatus?.model");
    expect(source).toContain("title={indexStatus?.model || undefined}");
    expect(source).toContain("api.testEmbeddingBackend()");
    expect(source).toContain("loading={embeddingTestBusy}");
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

  it("keeps disabled MCP servers editable without counting them as unavailable", () => {
    const rows = mcpRowsFromServers({
      apple: { type: "http", url: "http://127.0.0.1:7501/mcp", enabled: false },
    });

    expect(rows[0].enabled).toBe(false);
    expect(mcpServerFromRow(rows[0])).toEqual({
      name: "apple",
      config: { type: "http", url: "http://127.0.0.1:7501/mcp", enabled: false },
    });
    expect(mcpAvailabilitySummary({
      servers: [{ source: "user", available: false, disabled: true }],
    }, rows)).toMatchObject({
      status: "enabled",
      label: "Available",
      unavailable: 0,
      disabled: 1,
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
