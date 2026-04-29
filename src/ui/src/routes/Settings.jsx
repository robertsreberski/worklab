import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { AppShell } from "../components/AppShell.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { DurationInput, JsonField, NumberStepper, PathOrUrlInput } from "../components/primitives/index.js";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Icon } from "../components/Icon.jsx";
import { Page } from "../components/layout/index.js";
import {
  browserNotificationSettings,
  disableBrowserNotifications,
  requestAndEnableBrowserNotifications,
} from "../lib/browserNotifications.js";

const LOG_LEVEL_OPTIONS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"].map((value) => ({ value, label: value }));
const SLACK_EFFORT_OPTIONS = ["none", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value }));
const MCP_TRANSPORT_OPTIONS = [
  { value: "stdio", label: "stdio" },
  { value: "http", label: "HTTP" },
  { value: "sse", label: "SSE" },
];

function jsonEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function minutesValue(ms) {
  if (ms === "" || ms == null) return "";
  const minutes = Number(ms) / 60000;
  if (!Number.isFinite(minutes)) return "";
  return Number(minutes.toFixed(4)).toString();
}

export function minutesToMs(value) {
  if (value === "") return "";
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return "";
  return Math.round(minutes * 60000);
}

export function secondsValue(ms) {
  if (ms === "" || ms == null) return "";
  const seconds = Number(ms) / 1000;
  if (!Number.isFinite(seconds)) return "";
  return Number(seconds.toFixed(2)).toString();
}

export function secondsToMs(value) {
  if (value === "") return "";
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "";
  return Math.round(seconds * 1000);
}

function numberOrEmpty(value) {
  if (value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}

function listFromText(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function textFromList(value) {
  return Array.isArray(value) ? value.join("\n") : String(value || "");
}

function parseJsonObject(text, label) {
  if (!String(text || "").trim()) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${err.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function mcpRowsFromServers(servers = {}) {
  return Object.entries(servers).map(([name, config], index) => {
    const transport = config?.type === "http" || config?.type === "sse" ? config.type : "stdio";
    return {
      id: `${name}-${index}`,
      name,
      transport,
      command: config?.command || "",
      argsText: Array.isArray(config?.args) ? config.args.join("\n") : "",
      envText: config?.env ? JSON.stringify(config.env, null, 2) : "",
      url: config?.url || "",
      headersText: config?.headers ? JSON.stringify(config.headers, null, 2) : "",
    };
  });
}

function mcpServersFromRows(rows = []) {
  const servers = {};
  for (const row of rows) {
    const name = String(row.name || "").trim();
    if (!name) throw new Error("MCP server name is required");
    if (servers[name]) throw new Error(`Duplicate MCP server name: ${name}`);
    if (row.transport === "http" || row.transport === "sse") {
      if (!String(row.url || "").trim()) throw new Error(`MCP server ${name} requires a URL`);
      const next = { type: row.transport, url: String(row.url).trim() };
      const headers = parseJsonObject(row.headersText, `${name} headers`);
      if (headers) next.headers = headers;
      servers[name] = next;
    } else {
      if (!String(row.command || "").trim()) throw new Error(`MCP server ${name} requires an absolute command path`);
      const args = String(row.argsText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const env = parseJsonObject(row.envText, `${name} env`);
      const next = { command: String(row.command).trim() };
      if (args.length) next.args = args;
      if (env) next.env = env;
      servers[name] = next;
    }
  }
  return servers;
}

export function runtimePayload(runtimeDraft = {}) {
  return {
    host: runtimeDraft.host,
    port: Number(runtimeDraft.port),
    workspace: runtimeDraft.workspace,
    logLevel: runtimeDraft.logLevel,
    timezone: runtimeDraft.timezone || "",
    runIdleWarningMs: Number(runtimeDraft.runIdleWarningMs),
    logInlineLimit: Number(runtimeDraft.logInlineLimit),
  };
}

export function settingsPayload(settings = {}) {
  return {
    consolidation_hour: Number(settings.consolidation_hour),
    consolidation_enabled: !!settings.consolidation_enabled,
    worker_timeout_ms: Number(settings.worker_timeout_ms),
    cancel_grace_ms: Number(settings.cancel_grace_ms),
    journal_tail_lines: Number(settings.journal_tail_lines),
    kb_pinned_limit: Number(settings.kb_pinned_limit),
    default_embedding_model: settings.default_embedding_model || "",
    slack_enabled: !!settings.slack_enabled,
    slack_user_id: settings.slack_user_id || "",
    slack_agent_name: settings.slack_agent_name || "assistant",
    slack_model: settings.slack_model || "codex:gpt-5.5",
    slack_effort: settings.slack_effort || "xhigh",
    slack_channel_ids: Array.isArray(settings.slack_channel_ids)
      ? settings.slack_channel_ids
      : listFromText(settings.slack_channel_ids),
    slack_run_timeout_ms: Number(settings.slack_run_timeout_ms ?? 120000),
    slack_notify_task_completed: settings.slack_notify_task_completed !== false,
    slack_notify_task_errors: settings.slack_notify_task_errors !== false,
  };
}

function FieldNote({ label, value, mono = false }) {
  return (
    <div class="settings-note">
      <span>{label}</span>
      <strong class={mono ? "mono" : ""}>{value || "-"}</strong>
    </div>
  );
}

function notificationStatus(settings) {
  if (!settings?.supported) return { status: "disabled", label: "Unsupported" };
  if (settings.permission === "denied") return { status: "error", label: "Blocked" };
  if (settings.enabled) return { status: "enabled", label: "On" };
  return { status: "disabled", label: "Off" };
}

function notificationDescription(settings) {
  if (!settings?.supported) return "This browser does not support notifications.";
  if (settings.permission === "denied") return "Browser permission is blocked for this site.";
  return "Task run starts, completions, and errors in background tabs.";
}

export function slackUserMatchesBot(settings = {}, status = {}) {
  return !!(settings?.slack_user_id && status?.bot_user_id && settings.slack_user_id === status.bot_user_id);
}

export function slackRejectedSenderLabel(status = {}) {
  if (!status?.last_rejected) return "-";
  const parts = [];
  if (status.last_rejected.reason) parts.push(status.last_rejected.reason);
  if (status.last_rejected.user) parts.push(status.last_rejected.user);
  return parts.join(" / ") || "-";
}

function slackStatusMeta(status, settings) {
  if (!status?.enabled) return { status: "disabled", label: "Off" };
  if (slackUserMatchesBot(settings, status)) return { status: "error", label: "Bot ID configured" };
  if (!status?.token_present?.bot || !status?.token_present?.app) return { status: "error", label: "Missing tokens" };
  if (status.connected) return { status: "enabled", label: "Connected" };
  if (status.reason === "start_failed") return { status: "error", label: "Start failed" };
  return { status: "running", label: "Configured" };
}

export function serviceStatusMeta(runtime) {
  if (!runtime) return { status: "error", label: "Unavailable" };
  if (runtime.restartRequired) return { status: "running", label: "Restart pending" };
  if (runtime.service?.installed) {
    return {
      status: "enabled",
      label: runtime.service.platform ? `Installed (${runtime.service.platform})` : "Installed",
    };
  }
  return { status: "disabled", label: "Not installed" };
}

export function searchIndexMeta(status) {
  if (!status) return { status: "disabled", label: "Unknown" };
  if (Number(status.errors || 0) > 0) return { status: "error", label: "Has errors" };
  if (status.model && status.ready === false) return { status: "running", label: "Paused" };
  if (status.ready) return { status: "enabled", label: "Ready" };
  if (!status.model) return { status: "disabled", label: "No model" };
  return { status: "running", label: "Indexing" };
}

export function mcpAvailabilitySummary(status = {}, rows = []) {
  const servers = status?.servers || [];
  const unavailable = servers.filter((server) => server.available === false).length;
  const builtin = servers.filter((server) => server.source === "builtin").length;
  const user = rows.length;
  if (status?.config_error) return { status: "error", label: "Config error", builtin, user, unavailable };
  if (unavailable) return { status: "error", label: `${unavailable} unavailable`, builtin, user, unavailable };
  return { status: "enabled", label: "Available", builtin, user, unavailable };
}

function scrollToSettingsSection(id) {
  if (typeof document === "undefined") return;
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function SettingsOverviewCard({ icon, title, value, detail, status, statusLabel }) {
  return (
    <div class="settings-overview-card">
      <div class="settings-overview-icon"><Icon name={icon} size={18} /></div>
      <div class="settings-overview-copy">
        <span>{title}</span>
        <strong>{value || "-"}</strong>
        {detail && <small>{detail}</small>}
      </div>
      {status && <StatusPill status={status} label={statusLabel} size="sm" />}
    </div>
  );
}

function SettingsSection({ id, kicker, title, description, aside, children }) {
  return (
    <section id={id} class="settings-section-shell">
      <header class="settings-section-head">
        <div class="settings-section-copy">
          {kicker && <span class="form-section-kicker">{kicker}</span>}
          {title && <h2>{title}</h2>}
          {description && <p>{description}</p>}
        </div>
        {aside && <div class="settings-section-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

function SettingPanel({ icon, title, meta, status, statusLabel, children, class: className = "" }) {
  return (
    <div class={`settings-panel ${className}`.trim()}>
      <header class="settings-panel-head">
        <div class="settings-panel-title">
          {icon && <span class="settings-panel-icon"><Icon name={icon} size={16} /></span>}
          <div>
            <h3>{title}</h3>
            {meta && <p>{meta}</p>}
          </div>
        </div>
        {status && <StatusPill status={status} label={statusLabel} size="sm" />}
      </header>
      <div class="settings-panel-body">{children}</div>
    </div>
  );
}

function AdvancedSettings({ summary, count, defaultOpen = false, children }) {
  return (
    <details class="settings-advanced" open={defaultOpen}>
      <summary>
        <span>{summary}</span>
        {typeof count === "number" && <em>{count}</em>}
      </summary>
      <div class="settings-advanced-body">{children}</div>
    </details>
  );
}

export function Settings() {
  const [settings, setSettings] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [runtimeDraft, setRuntimeDraft] = useState(null);
  const [runtimeBaseline, setRuntimeBaseline] = useState(null);
  const [runtimeError, setRuntimeError] = useState(null);
  const [indexStatus, setIndexStatus] = useState(null);
  const [embeddingGroups, setEmbeddingGroups] = useState([]);
  const [modelGroups, setModelGroups] = useState([]);
  const [mcpStatus, setMcpStatus] = useState(null);
  const [mcpRows, setMcpRows] = useState([]);
  const [mcpBaselineRows, setMcpBaselineRows] = useState([]);
  const [slackStatus, setSlackStatus] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const [notificationSettingsState, setNotificationSettingsState] = useState(() => browserNotificationSettings());
  const [notificationBusy, setNotificationBusy] = useState(false);

  const loadSettings = useCallback(async () => {
    const response = await api.getSettings();
    setSettings(response.settings);
    setBaseline(response.settings);
  }, []);

  const loadRuntime = useCallback(async () => {
    try {
      const response = await api.getRuntimeSettings();
      setRuntime(response.runtime);
      setRuntimeDraft(response.runtime?.desired || null);
      setRuntimeBaseline(response.runtime?.desired || null);
      setRuntimeError(null);
    } catch (err) {
      const fallback = {
        host: "",
        port: "",
        workspace: "",
        logLevel: "info",
        timezone: "",
        runIdleWarningMs: 120000,
        logInlineLimit: 12000,
      };
      setRuntime(null);
      setRuntimeDraft(fallback);
      setRuntimeBaseline(fallback);
      setRuntimeError(err.message || "Runtime settings are unavailable");
    }
  }, []);

  const loadMcp = useCallback(async () => {
    const [config, status] = await Promise.all([
      api.getMcpConfig().catch(() => ({ mcpServers: {} })),
      api.getMcpStatus().catch(() => ({ servers: [], config_error: null })),
    ]);
    const rows = mcpRowsFromServers(config.mcpServers || {});
    setMcpRows(rows);
    setMcpBaselineRows(rows);
    setMcpStatus(status);
  }, []);

  const loadSlackStatus = useCallback(async () => {
    const response = await api.getSlackStatus();
    setSlackStatus(response.slack || null);
  }, []);

  useEffect(() => {
    loadSettings().catch((err) => pushToast(`Settings failed: ${err.message}`, { variant: "error" }));
    loadRuntime();
    api.searchStatus().then((r) => setIndexStatus(r.status)).catch(() => setIndexStatus(null));
    api.listEmbeddingModels().then((r) => setEmbeddingGroups(r.groups || [])).catch(() => setEmbeddingGroups([]));
    api.listAvailableModels().then((r) => setModelGroups(r.groups || [])).catch(() => setModelGroups([]));
    loadSlackStatus().catch(() => setSlackStatus(null));
    loadMcp().catch((err) => pushToast(`MCP failed: ${err.message}`, { variant: "error" }));
  }, [loadMcp, loadRuntime, loadSettings, loadSlackStatus]);

  const settingsDirty = useMemo(() => baseline ? !jsonEqual(settings, baseline) : false, [settings, baseline]);
  const runtimeDirty = useMemo(() => runtimeBaseline ? !jsonEqual(runtimeDraft, runtimeBaseline) : false, [runtimeDraft, runtimeBaseline]);
  const mcpDirty = useMemo(() => !jsonEqual(mcpRows, mcpBaselineRows), [mcpRows, mcpBaselineRows]);
  const isDirty = settingsDirty || runtimeDirty || mcpDirty;

  const formSave = useFormSave(async () => {
    if (settingsDirty) {
      const response = await api.patchSettings(settingsPayload(settings));
      setSettings(response.settings);
      setBaseline(response.settings);
      await loadSlackStatus().catch(() => {});
    }
    if (runtimeDirty) {
      await api.patchRuntimeSettings(runtimePayload(runtimeDraft));
      await loadRuntime();
      await loadSlackStatus().catch(() => {});
    }
    if (mcpDirty) {
      await api.putMcpConfig({ mcpServers: mcpServersFromRows(mcpRows) });
      await loadMcp();
    }
    pushToast("Saved.", { variant: "success" });
  });

  useGlobalShortcuts({
    cmds: (event) => { event.preventDefault(); formSave.save().catch(() => {}); },
  });

  const currentEmbedding = settings?.default_embedding_model || "";
  const allEmbeddingValues = embeddingGroups.flatMap((g) => (g.models || []).map((m) => m.value));
  const currentSlackModel = settings?.slack_model || "codex:gpt-5.5";
  const allModelValues = modelGroups.flatMap((g) => (g.models || []).map((m) => m.value));
  const slackModelOptions = [
    ...(currentSlackModel && !allModelValues.includes(currentSlackModel)
      ? [{ label: "Current", options: [{ value: currentSlackModel, label: `${currentSlackModel} (custom)` }] }]
      : []),
    ...modelGroups.map((g) => ({
      label: g.available === false ? `${g.label} (credentials not set)` : g.label,
      options: (g.models || []).map((m) => ({
        value: m.value,
        label: m.label || m.value,
        description: g.available === false ? (g.unavailable_reason || "Unavailable") : (m.description || m.unavailable_reason || undefined),
        disabled: g.available === false || m.available === false || m.disabled === true,
      })),
    })),
  ];
  const embeddingOptions = [
    { label: "", options: [{ value: "", label: "(disabled - no embeddings)" }] },
    ...(currentEmbedding && !allEmbeddingValues.includes(currentEmbedding)
      ? [{ label: "Current", options: [{ value: currentEmbedding, label: `${currentEmbedding} (custom)` }] }]
      : []),
    ...embeddingGroups.map((g) => ({
      label: g.available === false ? `${g.label} (credentials not set)` : g.label,
      options: (g.models || []).map((m) => ({
        value: m.value,
        label: m.label || m.value,
        description: g.available === false ? (g.unavailable_reason || "Unavailable") : (m.description || undefined),
        disabled: g.available === false || m.available === false || m.disabled === true,
      })),
    })),
  ];
  const slackMeta = slackStatusMeta(slackStatus, settings);
  const slackUserIsBot = slackUserMatchesBot(settings, slackStatus);

  async function restartRuntime() {
    setRestarting(true);
    try {
      const response = await api.restartRuntime();
      setRuntime(response.runtime || runtime);
      pushToast("Restart queued.", { variant: "success" });
    } catch (err) {
      pushToast(`Restart failed: ${err.message}`, { variant: "error" });
    } finally {
      setRestarting(false);
    }
  }

  function updateMcpRow(id, patch) {
    setMcpRows((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  }

  function addMcpRow() {
    const id = `new-${Date.now()}`;
    setMcpRows((rows) => [...rows, {
      id,
      name: "",
      transport: "stdio",
      command: "",
      argsText: "",
      envText: "",
      url: "",
      headersText: "",
    }]);
  }

  async function updateBrowserNotifications(enabled) {
    setNotificationBusy(true);
    try {
      if (enabled) {
        const next = await requestAndEnableBrowserNotifications();
        setNotificationSettingsState(next);
        if (next.enabled) {
          pushToast("Browser notifications enabled.", { variant: "success" });
        } else {
          pushToast("Browser notifications are blocked.", { variant: "error" });
        }
      } else {
        const next = disableBrowserNotifications();
        setNotificationSettingsState(next);
        pushToast("Browser notifications disabled.", { variant: "info" });
      }
    } catch (err) {
      setNotificationSettingsState(browserNotificationSettings());
      pushToast(`Notifications failed: ${err.message}`, { variant: "error" });
    } finally {
      setNotificationBusy(false);
    }
  }

  if (!settings || !runtimeDraft) {
    return (
      <AppShell route="settings">
        <Page><LoadingState caption="Loading settings..." /></Page>
      </AppShell>
    );
  }

  const pageActions = (
    <Button
      variant={isDirty ? "primary" : "secondary"}
      loading={formSave.saving}
      onClick={() => formSave.save().catch(() => {})}
    >
      Save
    </Button>
  );
  const notificationMeta = notificationStatus(notificationSettingsState);
  const serviceMeta = serviceStatusMeta(runtime);
  const searchMeta = searchIndexMeta(indexStatus);
  const mcpSummary = mcpAvailabilitySummary(mcpStatus, mcpRows);
  const builtinMcpServers = (mcpStatus?.servers || []).filter((server) => server.source === "builtin");
  const userMcpStatusByName = new Map(
    (mcpStatus?.servers || [])
      .filter((server) => server.source === "user")
      .map((server) => [server.name, server]),
  );
  const endpointLabel = runtimeDraft.host || runtimeDraft.port
    ? `${runtimeDraft.host || "-"}:${runtimeDraft.port || "-"}`
    : "-";
  const sectionLinks = [
    { id: "settings-runtime", label: "Runtime", icon: "settings" },
    { id: "settings-execution", label: "Execution", icon: "clock" },
    { id: "settings-notifications", label: "Notifications", icon: "message-circle" },
    { id: "settings-slack", label: "Slack", icon: "message-square" },
    { id: "settings-search", label: "Search", icon: "database" },
    { id: "settings-tools", label: "Tools", icon: "terminal" },
  ];

  return (
    <AppShell route="settings" mobileActionDock={isDirty || formSave.saving ? pageActions : null}>
      <Page
        class="settings-page"
        kicker="Settings"
        title="Settings"
        description="Service, workers, integrations, search, and MCP tools."
        actions={pageActions}
      >
        {formSave.error && (
          <Banner variant="error" title="Save failed" detail={formSave.error} actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>} />
        )}
        {runtime?.restartRequired && (
          <Banner
            variant="info"
            title="Restart required"
            detail="Runtime settings have desired values that differ from the running service."
            actions={<Button size="sm" loading={restarting} onClick={restartRuntime}>Restart</Button>}
          />
        )}
        {runtimeError && (
          <Banner
            variant="error"
            title="Runtime settings unavailable"
            detail={runtimeError}
          />
        )}

        <div class="settings-overview-grid">
          <SettingsOverviewCard
            icon="settings"
            title="Service"
            value={serviceMeta.label}
            detail={endpointLabel}
            status={serviceMeta.status}
            statusLabel={serviceMeta.label}
          />
          <SettingsOverviewCard
            icon="clock"
            title="Execution"
            value={`${minutesValue(settings.worker_timeout_ms) || "-"} min timeout`}
            detail={settings.consolidation_enabled ? `Memory at ${settings.consolidation_hour}:00` : "Memory refresh off"}
            status={settings.consolidation_enabled ? "enabled" : "disabled"}
            statusLabel={settings.consolidation_enabled ? "Memory on" : "Memory off"}
          />
          <SettingsOverviewCard
            icon="message-circle"
            title="Notifications"
            value={`Browser ${notificationMeta.label.toLowerCase()}`}
            detail={`Slack ${slackMeta.label.toLowerCase()}`}
            status={notificationMeta.status === "error" || slackMeta.status === "error" ? "error" : slackMeta.status}
            statusLabel={slackMeta.label}
          />
          <SettingsOverviewCard
            icon="database"
            title="Search"
            value={searchMeta.label}
            detail={indexStatus ? `${indexStatus.vectorized || 0}/${indexStatus.total || 0} vectorized` : "Index status unknown"}
            status={searchMeta.status}
            statusLabel={searchMeta.label}
          />
          <SettingsOverviewCard
            icon="terminal"
            title="MCP"
            value={mcpSummary.label}
            detail={`${mcpSummary.builtin} built-in / ${mcpSummary.user} external`}
            status={mcpSummary.status}
            statusLabel={mcpSummary.label}
          />
        </div>

        <nav class="settings-section-nav" aria-label="Settings sections">
          {sectionLinks.map((item) => (
            <button type="button" key={item.id} onClick={() => scrollToSettingsSection(item.id)}>
              <Icon name={item.icon} size={14} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div class="settings-sections">
          <SettingsSection
            id="settings-runtime"
            kicker="Runtime"
            title="Service runtime"
            description="Service boot values are written to the Worklab data-dir .env file."
            aside={<StatusPill status={serviceMeta.status} label={serviceMeta.label} />}
          >
            <div class="settings-panel-grid">
              <SettingPanel icon="folder" title="Workspace" meta="Agent working directory. Requires restart.">
                <FormField label="Workspace">
                  <PathOrUrlInput disabled={!!runtimeError} value={runtimeDraft.workspace} onInput={(event) => setRuntimeDraft({ ...runtimeDraft, workspace: event.target.value })} placeholder="/path/to/workspace" />
                </FormField>
              </SettingPanel>
              <SettingPanel icon="database" title="Environment snapshot" meta="Read-only runtime locations.">
                <div class="settings-note-grid">
                  <FieldNote label="Data directory" value={runtime?.readOnly?.dataDir} mono />
                  <FieldNote label="Repository" value={runtime?.readOnly?.repoRoot} mono />
                  <FieldNote label="Service" value={serviceMeta.label} />
                </div>
              </SettingPanel>
            </div>
            <AdvancedSettings summary="Network and process settings" count={4}>
              <FormGrid columns={3}>
                <FormField label="Host" hint="Requires restart.">
                  <Input disabled={!!runtimeError} value={runtimeDraft.host} onInput={(event) => setRuntimeDraft({ ...runtimeDraft, host: event.target.value })} />
                </FormField>
                <FormField label="Port" hint="Requires restart.">
                  <NumberStepper disabled={!!runtimeError} min={1} max={65535} value={runtimeDraft.port} ariaLabel="Port" onChange={(value) => setRuntimeDraft({ ...runtimeDraft, port: numberOrEmpty(value) })} />
                </FormField>
                <FormField label="Log level" hint="Requires restart.">
                  <Select disabled={!!runtimeError} variant="native" value={runtimeDraft.logLevel} options={LOG_LEVEL_OPTIONS} onChange={(value) => setRuntimeDraft({ ...runtimeDraft, logLevel: value })} />
                </FormField>
                <FormField label="Timezone" hint="Requires restart.">
                  <Input disabled={!!runtimeError} value={runtimeDraft.timezone || ""} placeholder="system local time" onInput={(event) => setRuntimeDraft({ ...runtimeDraft, timezone: event.target.value })} />
                </FormField>
              </FormGrid>
            </AdvancedSettings>
          </SettingsSection>

          <SettingsSection
            id="settings-execution"
            kicker="Execution"
            title="Workers and memory"
            description="Run limits and context controls used by new agent runs."
            aside={<StatusPill status={settings.consolidation_enabled ? "enabled" : "disabled"} label={settings.consolidation_enabled ? "Memory on" : "Memory off"} />}
          >
            <div class="settings-panel-grid">
              <SettingPanel icon="clock" title="Run limits" meta="Global timeout behavior for spawned workers.">
                <FormGrid columns={2}>
                  <FormField label="Worker timeout (minutes)">
                    <DurationInput value={settings.worker_timeout_ms} min={0.02} step={0.25} onChange={(value) => setSettings({ ...settings, worker_timeout_ms: value })} ariaLabel="Worker timeout" />
                  </FormField>
                  <FormField label="Cancel grace (seconds)">
                    <DurationInput unit="seconds" value={settings.cancel_grace_ms} min={0} step={1} onChange={(value) => setSettings({ ...settings, cancel_grace_ms: value })} ariaLabel="Cancel grace" />
                  </FormField>
                </FormGrid>
              </SettingPanel>
              <SettingPanel icon="book" title="Memory refresh" meta="Nightly consolidation for agent memory.">
                <div class="settings-switch-stack">
                  <Switch
                    checked={!!settings.consolidation_enabled}
                    onChange={(next) => setSettings({ ...settings, consolidation_enabled: next })}
                    label="Nightly consolidation"
                    description="Refresh agent memory once per day."
                  />
                  <FormField label="Consolidation hour">
                    <NumberStepper min={0} max={23} value={settings.consolidation_hour} ariaLabel="Consolidation hour" onChange={(value) => setSettings({ ...settings, consolidation_hour: value })} />
                  </FormField>
                </div>
              </SettingPanel>
            </div>
            <AdvancedSettings summary="Context and logging limits" count={4}>
              <FormGrid columns={3}>
                <FormField label="Journal tail lines">
                  <NumberStepper min={0} max={1000} value={settings.journal_tail_lines} ariaLabel="Journal tail lines" onChange={(value) => setSettings({ ...settings, journal_tail_lines: value })} />
                </FormField>
                <FormField label="Pinned KB limit">
                  <NumberStepper min={0} max={100} value={settings.kb_pinned_limit} ariaLabel="Pinned KB limit" onChange={(value) => setSettings({ ...settings, kb_pinned_limit: value })} />
                </FormField>
                <FormField label="Idle warning (minutes)" hint="Requires restart.">
                  <DurationInput disabled={!!runtimeError} value={runtimeDraft.runIdleWarningMs} min={0} step={0.25} onChange={(value) => setRuntimeDraft({ ...runtimeDraft, runIdleWarningMs: value })} ariaLabel="Idle warning" />
                </FormField>
                <FormField label="Inline log limit (chars)" hint="Requires restart.">
                  <NumberStepper disabled={!!runtimeError} min={0} value={runtimeDraft.logInlineLimit} ariaLabel="Inline log limit" onChange={(value) => setRuntimeDraft({ ...runtimeDraft, logInlineLimit: numberOrEmpty(value) })} />
                </FormField>
              </FormGrid>
            </AdvancedSettings>
          </SettingsSection>

          <SettingsSection
            id="settings-notifications"
            kicker="Browser"
            title="Notifications"
            description="Browser-local notification preference for this Worklab origin."
            aside={<StatusPill status={notificationMeta.status} label={notificationMeta.label} />}
          >
            <SettingPanel icon="message-circle" title="Browser notifications" meta={notificationDescription(notificationSettingsState)} status={notificationMeta.status} statusLabel={notificationMeta.label}>
              <Switch
                checked={!!notificationSettingsState.enabled}
                disabled={notificationBusy || !notificationSettingsState.supported}
                onChange={updateBrowserNotifications}
                label="Browser notifications"
                description={notificationDescription(notificationSettingsState)}
              />
            </SettingPanel>
          </SettingsSection>

          <SettingsSection
            id="settings-slack"
            kicker="Slack"
            title="Bot integration"
            description="Socket Mode bot for Slack triage and Worklab task notifications."
            aside={(
              <div class="settings-section-status">
                <StatusPill status={slackMeta.status} label={slackMeta.label} />
                {slackStatus?.bot_user_id && <span class="settings-inline-status">{slackStatus.bot_user_id}</span>}
              </div>
            )}
          >
            <div class="settings-panel-grid">
              <SettingPanel icon="message-square" title="Delivery" meta="Bot intake and outbound DMs." status={slackMeta.status} statusLabel={slackMeta.label}>
                <div class="settings-switch-stack">
                  <Switch
                    checked={!!settings.slack_enabled}
                    onChange={(next) => setSettings({ ...settings, slack_enabled: next })}
                    label="Slack bot"
                    description="Receive Slack messages and send task complete/error DMs."
                  />
                  <Switch
                    checked={!!settings.slack_notify_task_completed}
                    onChange={(next) => setSettings({ ...settings, slack_notify_task_completed: next })}
                    label="Task completions"
                    description="DM when a task reaches done."
                  />
                  <Switch
                    checked={!!settings.slack_notify_task_errors}
                    onChange={(next) => setSettings({ ...settings, slack_notify_task_errors: next })}
                    label="Task errors"
                    description="DM when a task run fails or blocks."
                  />
                </div>
              </SettingPanel>
              <SettingPanel icon="user" title="Identity" meta="Human recipient for DMs and commands." status={slackUserIsBot ? "error" : undefined} statusLabel={slackUserIsBot ? "Bot ID" : undefined}>
                <FormField label="Human Slack user ID" hint="This must be your Slack user ID, not the bot user ID.">
                  <Input value={settings.slack_user_id || ""} placeholder="U..." onInput={(event) => setSettings({ ...settings, slack_user_id: event.target.value })} />
                </FormField>
              </SettingPanel>
              <SettingPanel icon="sparkles" title="Run behavior" meta="Default model used for Slack-triggered runs.">
                <FormGrid columns={2}>
                  <FormField label="Default model" class="span-2">
                    <Select
                      value={currentSlackModel}
                      options={slackModelOptions}
                      onChange={(value) => setSettings({ ...settings, slack_model: value })}
                    />
                  </FormField>
                  <FormField label="Effort">
                    <Select
                      variant="native"
                      value={settings.slack_effort || "xhigh"}
                      options={SLACK_EFFORT_OPTIONS}
                      onChange={(value) => setSettings({ ...settings, slack_effort: value })}
                    />
                  </FormField>
                </FormGrid>
              </SettingPanel>
            </div>
            <AdvancedSettings summary="Routing and run tuning" count={3}>
              <FormGrid columns={3}>
                <FormField label="Bot memory name">
                  <Input value={settings.slack_agent_name || ""} placeholder="assistant" onInput={(event) => setSettings({ ...settings, slack_agent_name: event.target.value })} />
                </FormField>
                <FormField label="Run timeout (minutes)">
                  <DurationInput value={settings.slack_run_timeout_ms} min={0.02} step={0.25} onChange={(value) => setSettings({ ...settings, slack_run_timeout_ms: value })} ariaLabel="Slack run timeout" />
                </FormField>
                <FormField label="Channel allowlist" class="span-3" hint="Optional. Leave empty to accept all non-DM channels where the bot receives events.">
                  <Textarea
                    rows={3}
                    monospace
                    value={textFromList(settings.slack_channel_ids)}
                    placeholder={"C123...\nC456..."}
                    onInput={(event) => setSettings({ ...settings, slack_channel_ids: listFromText(event.target.value) })}
                  />
                </FormField>
              </FormGrid>
            </AdvancedSettings>
            <AdvancedSettings summary="Slack diagnostics" count={4} defaultOpen={!!slackStatus?.last_error || slackUserIsBot}>
              <div class="settings-note-grid">
                <FieldNote label="Last inbound" value={slackStatus?.last_inbound?.received_at ? new Date(slackStatus.last_inbound.received_at).toLocaleString() : "-"} />
                <FieldNote label="Last rejected" value={slackRejectedSenderLabel(slackStatus)} mono />
                <FieldNote label="Last run" value={slackStatus?.last_run?.status || "-"} />
                <FieldNote label="Last delivery" value={slackStatus?.last_delivery?.status || "-"} />
              </div>
            </AdvancedSettings>
            {slackUserIsBot && (
              <Banner
                variant="error"
                title="Human Slack user ID matches the bot"
                detail="Set the human Slack user ID to the person who should DM the bot and receive task notifications."
              />
            )}
            {slackStatus?.last_error && <Banner variant="error" title="Slack error" detail={slackStatus.last_error} />}
          </SettingsSection>

          <SettingsSection
            id="settings-search"
            kicker="Search"
            title="Embeddings"
            description="Embedding model selection and index health."
            aside={<StatusPill status={searchMeta.status} label={searchMeta.label} />}
          >
            <SettingPanel icon="database" title="Knowledge search" meta="Controls vectorization for knowledge and journals." status={searchMeta.status} statusLabel={searchMeta.label}>
              <FormField
                label="Embedding model"
                hint='Disabled skips vectorization. Run "Discover" on a provider, then enable an embedding model to select it here.'
              >
                <Select
                  value={currentEmbedding}
                  options={embeddingOptions}
                  onChange={(value) => setSettings({ ...settings, default_embedding_model: value })}
                />
              </FormField>
              <div class={`settings-index-status ${indexStatus?.errors ? "has-errors" : ""}`}>
                <FieldNote label="Chunks" value={indexStatus ? indexStatus.total : "-"} />
                <FieldNote label="Vectorized" value={indexStatus ? indexStatus.vectorized : "-"} />
                <FieldNote label="Errors" value={indexStatus ? indexStatus.errors : "-"} />
                <FieldNote label="Model" value={indexStatus?.model || "-"} mono />
              </div>
              {indexStatus?.model && !indexStatus.ready && (
                <div class="settings-inline-warning">Paused: {indexStatus.reason || "provider not configured"}</div>
              )}
            </SettingPanel>
          </SettingsSection>

          <SettingsSection
            id="settings-tools"
            kicker="Tools"
            title="MCP servers"
            description="Built-in servers are read-only. User servers are saved to the MCP config file."
            aside={<StatusPill status={mcpSummary.status} label={mcpSummary.label} />}
          >
            {mcpStatus?.config_error && <Banner variant="error" title="MCP config error" detail={mcpStatus.config_error} />}
            <div class="settings-panel-grid">
              {builtinMcpServers.map((server) => (
                <SettingPanel
                  key={server.name}
                  icon="terminal"
                  title={server.name}
                  meta={`${server.transport} / built-in`}
                  status={server.available === false ? "error" : "enabled"}
                  statusLabel={server.available === false ? "Unavailable" : "Available"}
                >
                  <div class="settings-inline-status">{server.unavailable_reason || "Ready for agent MCP allowlists."}</div>
                </SettingPanel>
              ))}
              {builtinMcpServers.length === 0 && (
                <SettingPanel icon="terminal" title="Built-in servers" meta="No built-in MCP servers reported." status="disabled" statusLabel="None">
                  <div class="settings-inline-status">No built-in MCP servers are available.</div>
                </SettingPanel>
              )}
            </div>
            <div class="settings-list-head">
              <div>
                <h3>External MCP servers</h3>
                <p>{mcpRows.length ? `${mcpRows.length} configured` : "No external servers configured"}</p>
              </div>
              <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={12} />} onClick={addMcpRow}>Add MCP server</Button>
            </div>
            <div class="settings-list">
              {mcpRows.length === 0 && <div class="settings-empty-note">External MCP servers can be added when an agent needs tools outside Worklab.</div>}
              {mcpRows.map((row) => {
                const serverStatus = userMcpStatusByName.get(row.name);
                const status = row.name
                  ? (serverStatus?.available === false ? "error" : "enabled")
                  : "disabled";
                const statusLabel = row.name
                  ? (serverStatus?.available === false ? "Unavailable" : "Configured")
                  : "Draft";
                return (
                <div class="settings-admin-row settings-mcp-row" key={row.id}>
                  <div class="settings-mcp-head">
                    <div>
                      <strong>{row.name || "New MCP server"}</strong>
                      <div class="settings-row-sub">{row.transport} / external</div>
                    </div>
                    <div class="settings-row-actions">
                      <StatusPill status={status} label={statusLabel} size="sm" />
                      <Button variant="destructive" size="sm" iconLeft={<Icon name="trash" size={12} />} onClick={() => setMcpRows((rows) => rows.filter((item) => item.id !== row.id))}>Delete</Button>
                    </div>
                  </div>
                  <FormGrid columns={3}>
                    <FormField label="Name">
                      <Input value={row.name} onInput={(event) => updateMcpRow(row.id, { name: event.target.value })} />
                    </FormField>
                    <FormField label="Transport">
                      <Select variant="native" value={row.transport} options={MCP_TRANSPORT_OPTIONS} onChange={(value) => updateMcpRow(row.id, { transport: value })} />
                    </FormField>
                  </FormGrid>
                  <AdvancedSettings summary="Connection details" count={row.transport === "stdio" ? 3 : 2} defaultOpen={!row.name || row.id.startsWith("new-")}>
                    <FormGrid columns={3}>
                    {row.transport === "stdio" ? (
                      <>
                        <FormField label="Command" class="span-2">
                          <PathOrUrlInput value={row.command} onInput={(event) => updateMcpRow(row.id, { command: event.target.value })} placeholder="/absolute/path/to/server" />
                        </FormField>
                        <FormField label="Args (one per line)">
                          <Textarea rows={3} value={row.argsText} onInput={(event) => updateMcpRow(row.id, { argsText: event.target.value })} />
                        </FormField>
                        <FormField label="Env JSON" class="span-3">
                          <JsonField rows={3} value={row.envText} onInput={(event) => updateMcpRow(row.id, { envText: event.target.value })} placeholder='{"KEY":"value"}' />
                        </FormField>
                      </>
                    ) : (
                      <>
                        <FormField label="URL" class="span-2">
                          <PathOrUrlInput kind="url" value={row.url} onInput={(event) => updateMcpRow(row.id, { url: event.target.value })} placeholder="http://localhost:3000/mcp" />
                        </FormField>
                        <FormField label="Headers JSON">
                          <JsonField rows={3} value={row.headersText} onInput={(event) => updateMcpRow(row.id, { headersText: event.target.value })} placeholder='{"Authorization":"Bearer ..."}' />
                        </FormField>
                      </>
                    )}
                    </FormGrid>
                    {serverStatus?.unavailable_reason && <div class="settings-inline-warning">{serverStatus.unavailable_reason}</div>}
                  </AdvancedSettings>
                </div>
                );
              })}
            </div>
          </SettingsSection>

        </div>
      </Page>
    </AppShell>
  );
}
