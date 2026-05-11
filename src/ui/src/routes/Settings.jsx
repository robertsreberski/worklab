import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { useAppResume } from "../lib/pageVisibility.js";
import { AppShell } from "../components/AppShell.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { ProvidersTab } from "./settings/ProvidersTab.jsx";
import { navigateHash } from "../lib/navigation.js";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { DurationInput, JsonField, NumberStepper, PathOrUrlInput } from "../components/primitives/index.js";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { AgentLink } from "../components/AgentLink.jsx";
import { Icon } from "../components/Icon.jsx";
import { ControlGroup, ControlGroupStack, InlineHead, Page, PanelGrid, SectionStack, Toolbar } from "../components/layout/index.js";
import {
  disableNotifications,
  notificationSettings,
  requestAndEnableNotifications,
} from "../lib/browserNotifications.js";
import {
  AdvancedSettings,
  FieldNote,
  SettingPanel,
  SettingsOverviewCard,
  SettingsSection,
} from "./settings/components.jsx";
import {
  LOG_LEVEL_OPTIONS,
  MCP_TRANSPORT_OPTIONS,
  PLANNING_HARNESS_SELECT_OPTIONS,
  PLANNING_TOOL_POLICY_SELECT_OPTIONS,
  SLACK_EFFORT_OPTIONS,
  VERIFICATION_ADJUDICATOR_MODE_OPTIONS,
  jsonEqual,
  mcpAvailabilitySummary,
  mcpRowsFromServers,
  mcpServerFromRow,
  mcpServersFromRows,
  minutesValue,
  modelSelectOptions,
  notificationDescription,
  notificationDiagnosticText,
  notificationEnableToast,
  notificationStatus,
  numberOrEmpty,
  runtimePayload,
  scrollToSettingsSection,
  searchIndexMeta,
  serviceStatusMeta,
  settingsPayload,
  slackRejectedSenderLabel,
  slackStatusMeta,
  slackUserMatchesBot,
  textFromList,
} from "./settings/helpers.js";

const MCP_HEALTH_ALL_KEY = "__all";

const SETTINGS_SECTION_LINKS = [
  { id: "settings-runtime", label: "Service", icon: "settings" },
  { id: "settings-execution", label: "Agent runs", icon: "clock" },
  { id: "settings-notifications", label: "Notifications", icon: "message-circle" },
  { id: "settings-assistant", label: "Assistant", icon: "sparkles" },
  { id: "settings-slack", label: "Slack", icon: "message-square" },
  { id: "settings-search", label: "Search", icon: "database" },
  { id: "settings-tools", label: "MCP tools", icon: "terminal" },
];

function mcpHealthRowKey(id) {
  return `row:${id}`;
}

function mcpHealthBuiltinKey(name) {
  return `builtin:${name}`;
}

function localMcpHealthError(row, message) {
  return {
    name: row.name || "Draft",
    source: "draft",
    transport: row.transport || "stdio",
    health: "error",
    static_available: false,
    message,
    duration_ms: 0,
    tool_count: 0,
    tools_preview: [],
  };
}

function mcpHealthMeta(result) {
  if (!result) return null;
  if (result.health === "ok") return { status: "enabled", label: "Healthy" };
  return { status: "error", label: "Check failed" };
}

function mcpHealthDetail(result) {
  if (!result) return "";
  const parts = [result.message || (result.health === "ok" ? "Connected" : "Health check failed")];
  if (Number.isFinite(Number(result.duration_ms))) parts.push(`${Math.round(Number(result.duration_ms))}ms`);
  if (result.health === "ok" && result.tools_preview?.length) {
    parts.push(`Tools: ${result.tools_preview.join(", ")}`);
  }
  return parts.filter(Boolean).join(" / ");
}

function buildMcpHealthDraft(rows = []) {
  const servers = {};
  const rowByName = new Map();
  const rowsByName = new Map();
  const errors = {};
  for (const row of rows) {
    try {
      const { name, config } = mcpServerFromRow(row);
      const duplicate = rowsByName.get(name);
      if (duplicate) {
        const message = `Duplicate MCP server name: ${name}`;
        errors[mcpHealthRowKey(duplicate.id)] = localMcpHealthError(duplicate, message);
        errors[mcpHealthRowKey(row.id)] = localMcpHealthError(row, message);
        delete servers[name];
        rowByName.delete(name);
        continue;
      }
      rowsByName.set(name, row);
      rowByName.set(name, row.id);
      servers[name] = config;
    } catch (err) {
      errors[mcpHealthRowKey(row.id)] = localMcpHealthError(row, err.message || String(err));
    }
  }
  return { servers, rowByName, errors };
}

const SETTINGS_TAB_ORDER = ["general", "providers", "about"];
const SETTINGS_TAB_LABELS = { general: "General", providers: "Providers", about: "About" };

function AboutTab() {
  return (
    <div class="settings-about">
      <p>
        <strong>Worklab</strong> — local agents.
      </p>
      <p class="soft-meta">
        A single-user, local AI agent orchestration app. Everything runs on your
        machine; the assistant dock is summoned with <kbd>⌘\</kbd>; press <kbd>?</kbd>
        anywhere for keyboard shortcuts.
      </p>
    </div>
  );
}

export function Settings({ tab = "general", rest = [] }) {
  const activeTab = SETTINGS_TAB_ORDER.includes(tab) ? tab : "general";
  if (activeTab === "providers") {
    const [item] = rest;
    return (
      <AppShell route="settings">
        <div class="settings-page settings-route-compact">
          <Tabs
            value={activeTab}
            onChange={(next) => navigateHash(next === "general" ? "#/settings" : `#/settings/${next}`)}
            tabs={SETTINGS_TAB_ORDER.map((id) => ({ value: id, label: SETTINGS_TAB_LABELS[id] }))}
            ariaLabel="Settings tabs"
            class="settings-tabs tabs-pills"
          />
          <ProvidersTab selectedId={item || null} />
        </div>
      </AppShell>
    );
  }
  if (activeTab === "about") {
    return (
      <AppShell route="settings">
        <div class="settings-page">
          <div class="ds-page-head">
            <div class="ds-page-title">
              <span class="form-section-kicker">Settings</span>
              <h1>Settings</h1>
            </div>
          </div>
          <Tabs
            value={activeTab}
            onChange={(next) => navigateHash(next === "general" ? "#/settings" : `#/settings/${next}`)}
            tabs={SETTINGS_TAB_ORDER.map((id) => ({ value: id, label: SETTINGS_TAB_LABELS[id] }))}
            ariaLabel="Settings tabs"
            class="settings-tabs tabs-pills"
          />
          <AboutTab />
        </div>
      </AppShell>
    );
  }
  return <SettingsGeneral />;
}

function SettingsGeneral() {
  const [settings, setSettings] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [runtimeDraft, setRuntimeDraft] = useState(null);
  const [runtimeBaseline, setRuntimeBaseline] = useState(null);
  const [runtimeError, setRuntimeError] = useState(null);
  const [indexStatus, setIndexStatus] = useState(null);
  const [embeddingGroups, setEmbeddingGroups] = useState([]);
  const [verificationAdjudicatorGroups, setVerificationAdjudicatorGroups] = useState([]);
  const [modelGroups, setModelGroups] = useState([]);
  const [agents, setAgents] = useState([]);
  const [mcpStatus, setMcpStatus] = useState(null);
  const [mcpRows, setMcpRows] = useState([]);
  const [mcpBaselineRows, setMcpBaselineRows] = useState([]);
  const [mcpHealthResults, setMcpHealthResults] = useState({});
  const [mcpHealthBusy, setMcpHealthBusy] = useState({});
  const [slackStatus, setSlackStatus] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const [notificationSettingsState, setNotificationSettingsState] = useState(() => notificationSettings());
  const [notificationServerStatus, setNotificationServerStatus] = useState(null);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [activeSectionId, setActiveSectionId] = useState(SETTINGS_SECTION_LINKS[0].id);

  const loadSettings = useCallback(async (options = {}) => {
    const response = await api.getSettings(options);
    setSettings(response.settings);
    setBaseline(response.settings);
    setLoadError(null);
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
    setMcpHealthResults({});
    setMcpHealthBusy({});
  }, []);

  const loadSlackStatus = useCallback(async () => {
    const response = await api.getSlackStatus();
    setSlackStatus(response.slack || null);
  }, []);

  const loadNotificationStatus = useCallback(async () => {
    const response = await api.getNotificationStatus();
    setNotificationServerStatus(response || null);
    return response;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadSettings({ signal: controller.signal }).catch((err) => {
      if (err?.name === "AbortError") return;
      setLoadError(err.message || "Settings failed");
      pushToast(`Settings failed: ${err.message}`, { variant: "error" });
    });
    loadRuntime();
    api.searchStatus().then((r) => setIndexStatus(r.status)).catch(() => setIndexStatus(null));
    api.listEmbeddingModels().then((r) => setEmbeddingGroups(r.groups || [])).catch(() => setEmbeddingGroups([]));
    api.listVerificationAdjudicatorModels().then((r) => setVerificationAdjudicatorGroups(r.groups || [])).catch(() => setVerificationAdjudicatorGroups([]));
    api.listAvailableModels().then((r) => setModelGroups(r.groups || [])).catch(() => setModelGroups([]));
    api.listAgents({ signal: controller.signal }).then((r) => setAgents(r.agents || [])).catch((err) => {
      if (err?.name !== "AbortError") setAgents([]);
    });
    loadSlackStatus().catch(() => setSlackStatus(null));
    loadNotificationStatus().catch(() => setNotificationServerStatus(null));
    loadMcp().catch((err) => pushToast(`MCP failed: ${err.message}`, { variant: "error" }));
    return () => controller.abort();
  }, [loadMcp, loadNotificationStatus, loadRuntime, loadSettings, loadSlackStatus]);

  const settingsDirty = useMemo(() => baseline ? !jsonEqual(settings, baseline) : false, [settings, baseline]);
  const runtimeDirty = useMemo(() => runtimeBaseline ? !jsonEqual(runtimeDraft, runtimeBaseline) : false, [runtimeDraft, runtimeBaseline]);
  const mcpDirty = useMemo(() => !jsonEqual(mcpRows, mcpBaselineRows), [mcpRows, mcpBaselineRows]);
  const isDirty = settingsDirty || runtimeDirty || mcpDirty;
  useAppResume(() => {
    api.searchStatus().then((r) => setIndexStatus(r.status)).catch(() => setIndexStatus(null));
    api.listEmbeddingModels().then((r) => setEmbeddingGroups(r.groups || [])).catch(() => setEmbeddingGroups([]));
    api.listVerificationAdjudicatorModels().then((r) => setVerificationAdjudicatorGroups(r.groups || [])).catch(() => setVerificationAdjudicatorGroups([]));
    api.listAvailableModels().then((r) => setModelGroups(r.groups || [])).catch(() => setModelGroups([]));
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
    loadSlackStatus().catch(() => setSlackStatus(null));
    setNotificationSettingsState(notificationSettings());
    loadNotificationStatus().catch(() => setNotificationServerStatus(null));
    if (!isDirty) {
      loadSettings().catch((err) => setLoadError(err.message || "Settings failed"));
      loadRuntime();
      loadMcp().catch((err) => pushToast(`MCP failed: ${err.message}`, { variant: "error" }));
    }
  });

  const settingsReady = !!settings && !!runtimeDraft;
  const selectSettingsSection = useCallback((id) => {
    if (!id) return;
    setActiveSectionId(id);
    scrollToSettingsSection(id);
  }, []);

  useEffect(() => {
    if (!settingsReady || typeof window === "undefined") return;
    const sections = SETTINGS_SECTION_LINKS
      .map((item) => document.getElementById(item.id))
      .filter(Boolean);
    if (!sections.length) return;
    let frame = null;
    const updateActiveSection = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const marker = 128;
        const sectionAtMarker = sections.find((section) => {
          const rect = section.getBoundingClientRect();
          return rect.top <= marker && rect.bottom > marker;
        });
        const nearestSection = sectionAtMarker || sections
          .map((section) => ({ section, distance: Math.abs(section.getBoundingClientRect().top - marker) }))
          .sort((a, b) => a.distance - b.distance)[0]?.section;
        if (nearestSection?.id) setActiveSectionId(nearestSection.id);
      });
    };
    updateActiveSection();
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    };
  }, [settingsReady]);

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
  const currentSlackModel = settings?.slack_model || "pi:openai-codex:gpt-5.5";
  const currentAssistantModel = settings?.assistant_model || "pi:openai-codex:gpt-5.5";
  const currentAdjudicatorModel = settings?.agent_verification_adjudicator_model || "";
  const slackModelOptions = modelSelectOptions(modelGroups, currentSlackModel);
  const assistantModelOptions = modelSelectOptions(modelGroups, currentAssistantModel);
  const adjudicatorModelOptions = [
    { label: "", options: [{ value: "", label: "(select a provider model)" }] },
    ...modelSelectOptions(verificationAdjudicatorGroups, currentAdjudicatorModel),
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
    setMcpHealthResults((results) => {
      const next = { ...results };
      delete next[mcpHealthRowKey(id)];
      return next;
    });
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

  function setMcpBusy(key, busy) {
    setMcpHealthBusy((current) => {
      const next = { ...current };
      if (busy) next[key] = true;
      else delete next[key];
      return next;
    });
  }

  function setMcpHealthForRow(id, result) {
    setMcpHealthResults((current) => ({ ...current, [mcpHealthRowKey(id)]: result }));
  }

  function deleteMcpRow(id) {
    setMcpRows((rows) => rows.filter((item) => item.id !== id));
    setMcpHealthResults((results) => {
      const next = { ...results };
      delete next[mcpHealthRowKey(id)];
      return next;
    });
  }

  async function checkMcpRowHealth(row) {
    const key = mcpHealthRowKey(row.id);
    setMcpBusy(key, true);
    try {
      const { name, config } = mcpServerFromRow(row);
      const response = await api.checkMcpHealth({
        includeBuiltins: false,
        mcpServers: { [name]: config },
        names: [name],
      });
      setMcpHealthForRow(row.id, response.results?.[0] || localMcpHealthError(row, "No health result returned"));
    } catch (err) {
      setMcpHealthForRow(row.id, localMcpHealthError(row, err.message || String(err)));
    } finally {
      setMcpBusy(key, false);
    }
  }

  async function checkAllMcpHealth() {
    const { servers, rowByName, errors } = buildMcpHealthDraft(mcpRows);
    setMcpBusy(MCP_HEALTH_ALL_KEY, true);
    setMcpHealthResults((current) => {
      const next = { ...current };
      for (const row of mcpRows) delete next[mcpHealthRowKey(row.id)];
      for (const server of builtinMcpServers) delete next[mcpHealthBuiltinKey(server.name)];
      return { ...next, ...errors };
    });
    try {
      const response = await api.checkMcpHealth({ includeBuiltins: true, mcpServers: servers });
      const nextResults = {};
      for (const result of response.results || []) {
        if (result.source === "builtin") {
          nextResults[mcpHealthBuiltinKey(result.name)] = result;
        } else {
          const rowId = rowByName.get(result.name);
          if (rowId) nextResults[mcpHealthRowKey(rowId)] = result;
        }
      }
      setMcpHealthResults((current) => ({ ...current, ...nextResults }));
      pushToast("MCP health check complete.", { variant: "success" });
    } catch (err) {
      pushToast(`MCP health check failed: ${err.message}`, { variant: "error" });
    } finally {
      setMcpBusy(MCP_HEALTH_ALL_KEY, false);
    }
  }

  async function updateBrowserNotifications(enabled) {
    setNotificationBusy(true);
    try {
      if (enabled) {
        const next = await requestAndEnableNotifications({ api });
        setNotificationSettingsState(next);
        if (next.serverStatus) setNotificationServerStatus(next.serverStatus);
        const toast = notificationEnableToast(next);
        pushToast(toast.message, { variant: toast.variant });
        await loadNotificationStatus().catch(() => {});
      } else {
        const next = await disableNotifications({ api });
        setNotificationSettingsState(next);
        pushToast("Notifications disabled.", { variant: "info" });
        await loadNotificationStatus().catch(() => {});
      }
    } catch (err) {
      setNotificationSettingsState(notificationSettings());
      pushToast(`Notifications failed: ${err.message}`, { variant: "error" });
    } finally {
      setNotificationBusy(false);
    }
  }

  if (!settings || !runtimeDraft) {
    return (
      <AppShell route="settings">
        <Page>
          {loadError ? (
            <Banner
              variant="error"
              title="Settings failed to load"
              detail={loadError}
              actions={<Button size="sm" variant="secondary" onClick={() => loadSettings().catch((err) => setLoadError(err.message || "Settings failed"))}>Retry</Button>}
            />
          ) : (
            <LoadingState caption="Loading settings..." />
          )}
        </Page>
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
  const notificationModeDetail = notificationSettingsState?.mode === "pwa" ? "Web Push notifications" : "Browser notifications";
  const serviceMeta = serviceStatusMeta(runtime);
  const searchMeta = searchIndexMeta(indexStatus);
  const mcpSummary = mcpAvailabilitySummary(mcpStatus, mcpRows);
  const builtinMcpServers = (mcpStatus?.servers || []).filter((server) => server.source === "builtin");
  const userMcpStatusByName = new Map(
    (mcpStatus?.servers || [])
      .filter((server) => server.source === "user")
      .map((server) => [server.name, server]),
  );
  const mcpAllBusy = !!mcpHealthBusy[MCP_HEALTH_ALL_KEY];
  const endpointLabel = runtimeDraft.host || runtimeDraft.port
    ? `${runtimeDraft.host || "-"}:${runtimeDraft.port || "-"}`
    : "-";
  const overviewCards = [
    {
      targetId: "settings-runtime",
      icon: "settings",
      title: "Service",
      value: serviceMeta.label,
      detail: endpointLabel,
      status: serviceMeta.status,
      statusLabel: serviceMeta.label,
    },
    {
      targetId: "settings-execution",
      icon: "clock",
      title: "Agent runs",
      value: `${minutesValue(settings.worker_timeout_ms) || "-"} min timeout`,
      detail: settings.consolidation_enabled ? `Memory at ${settings.consolidation_hour}:00` : "Memory refresh off",
      status: settings.consolidation_enabled ? "enabled" : "disabled",
      statusLabel: settings.consolidation_enabled ? "Memory on" : "Memory off",
    },
    {
      targetId: "settings-notifications",
      icon: "message-circle",
      title: "Notifications",
      value: `${notificationSettingsState?.mode === "pwa" ? "PWA" : "Browser"} ${notificationMeta.label.toLowerCase()}`,
      detail: notificationModeDetail,
      status: notificationMeta.status,
      statusLabel: notificationMeta.label,
    },
    {
      targetId: "settings-assistant",
      icon: "sparkles",
      title: "Assistant",
      value: currentAssistantModel,
      detail: `Memory ${settings.slack_agent_name || "assistant"}`,
      status: "enabled",
      statusLabel: "Available",
    },
    {
      targetId: "settings-slack",
      icon: "message-square",
      title: "Slack",
      value: slackMeta.label,
      detail: slackStatus?.bot_user_id ? `Bot ${slackStatus.bot_user_id}` : "Socket Mode bot",
      status: slackMeta.status,
      statusLabel: slackMeta.label,
    },
    {
      targetId: "settings-search",
      icon: "database",
      title: "Search",
      value: searchMeta.label,
      detail: indexStatus ? `${indexStatus.vectorized || 0}/${indexStatus.total || 0} vectorized` : "Index status unknown",
      status: searchMeta.status,
      statusLabel: searchMeta.label,
    },
    {
      targetId: "settings-tools",
      icon: "terminal",
      title: "MCP tools",
      value: mcpSummary.label,
      detail: `${mcpSummary.builtin} built-in / ${mcpSummary.user} external`,
      status: mcpSummary.status,
      statusLabel: mcpSummary.label,
    },
  ];

  return (
    <AppShell route="settings" mobileActionDock={isDirty || formSave.saving ? pageActions : null}>
      <Page
        class="settings-page"
        kicker="Settings"
        title="Settings"
        description="Service runtime, agent runs, notifications, assistant behavior, Slack, search, and MCP tools."
        actions={pageActions}
      >
        <Tabs
          value="general"
          onChange={(next) => navigateHash(next === "general" ? "#/settings" : `#/settings/${next}`)}
          tabs={SETTINGS_TAB_ORDER.map((id) => ({ value: id, label: SETTINGS_TAB_LABELS[id] }))}
          ariaLabel="Settings tabs"
          class="settings-tabs tabs-pills"
        />
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

        <PanelGrid class="settings-overview-grid">
          {overviewCards.map((card) => (
            <SettingsOverviewCard
              key={card.targetId}
              {...card}
              active={activeSectionId === card.targetId}
              onSelect={selectSettingsSection}
            />
          ))}
        </PanelGrid>

        <nav class="settings-section-nav" aria-label="Settings sections">
          {SETTINGS_SECTION_LINKS.map((item) => (
            <Button
              variant="ghost"
              size="sm"
              key={item.id}
              class={activeSectionId === item.id ? "is-active" : ""}
              aria-current={activeSectionId === item.id ? "location" : undefined}
              onClick={() => selectSettingsSection(item.id)}
            >
              <Icon name={item.icon} size={14} />
              <span>{item.label}</span>
            </Button>
          ))}
        </nav>

        <div class="settings-sections">
          <SettingsSection
            id="settings-runtime"
            kicker="Service"
            title="Service runtime"
            description="Service boot values are written to the Worklab data-dir .env file."
            aside={<StatusPill status={serviceMeta.status} label={serviceMeta.label} />}
          >
            <PanelGrid class="settings-panel-grid">
              <SettingPanel icon="folder" title="Workspace" meta="Agent working directory. Requires restart.">
                <FormField label="Workspace">
                  <PathOrUrlInput disabled={!!runtimeError} value={runtimeDraft.workspace} onInput={(event) => setRuntimeDraft({ ...runtimeDraft, workspace: event.target.value })} placeholder="/path/to/workspace" />
                </FormField>
              </SettingPanel>
              <SettingPanel icon="database" title="Environment snapshot" meta="Read-only runtime locations.">
                <PanelGrid class="settings-note-grid settings-note-grid-paths">
                  <FieldNote label="Data directory" value={runtime?.readOnly?.dataDir} mono />
                  <FieldNote label="Repository" value={runtime?.readOnly?.repoRoot} mono />
                  <FieldNote label="Service" value={serviceMeta.label} />
                </PanelGrid>
              </SettingPanel>
            </PanelGrid>
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
            kicker="Agent runs"
            title="Workers, planning, and memory"
            description="Run limits, memory refresh, planning harness, and log context for new agent runs."
            aside={<StatusPill status={settings.consolidation_enabled ? "enabled" : "disabled"} label={settings.consolidation_enabled ? "Memory on" : "Memory off"} />}
          >
            <PanelGrid class="settings-panel-grid">
              <SettingPanel icon="clock" title="Run limits" meta="Global timeout behavior for spawned workers.">
                <FormGrid columns={2}>
                  <FormField label="Worker timeout">
                    <DurationInput value={settings.worker_timeout_ms} min={0.02} step={0.25} onChange={(value) => setSettings({ ...settings, worker_timeout_ms: value })} ariaLabel="Worker timeout" />
                  </FormField>
                  <FormField label="Cancel grace">
                    <DurationInput unit="seconds" value={settings.cancel_grace_ms} min={0} step={1} onChange={(value) => setSettings({ ...settings, cancel_grace_ms: value })} ariaLabel="Cancel grace" />
                  </FormField>
                </FormGrid>
              </SettingPanel>
              <SettingPanel icon="book" title="Memory refresh" meta="Nightly consolidation for agent memory.">
                <SectionStack class="settings-switch-stack">
                  <Switch
                    checked={!!settings.consolidation_enabled}
                    onChange={(next) => setSettings({ ...settings, consolidation_enabled: next })}
                    label="Nightly consolidation"
                    description="Refresh agent memory once per day."
                  />
                  <Switch
                    checked={settings.agent_learning_enabled !== false}
                    onChange={(next) => setSettings({ ...settings, agent_learning_enabled: next })}
                    label="Structured learning"
                    description="Use approved learning records in future run prompts."
                  />
                  <FormField label="Consolidation hour">
                    <NumberStepper min={0} max={23} value={settings.consolidation_hour} ariaLabel="Consolidation hour" onChange={(value) => setSettings({ ...settings, consolidation_hour: value })} />
                  </FormField>
                </SectionStack>
              </SettingPanel>
              <SettingPanel icon="file-text" title="Planning harness" meta="Plan-stage prompt and tool policy.">
                <FormGrid columns={2} class="settings-planning-grid">
                  <FormField label="Harness">
                    <Select
                      value={settings.planning_harness || "balanced_polished"}
                      options={PLANNING_HARNESS_SELECT_OPTIONS}
                      onChange={(value) => setSettings({ ...settings, planning_harness: value })}
                    />
                  </FormField>
                  <FormField label="Tool policy">
                    <Select
                      value={settings.planning_tool_policy || "read_only_shell_allowlist"}
                      options={PLANNING_TOOL_POLICY_SELECT_OPTIONS}
                      onChange={(value) => setSettings({ ...settings, planning_tool_policy: value })}
                    />
                  </FormField>
                </FormGrid>
              </SettingPanel>
            </PanelGrid>
            <AdvancedSettings summary="Context and logging limits" count={6}>
              <FormGrid columns={3}>
                <FormField label="Journal tail lines">
                  <NumberStepper min={0} max={1000} value={settings.journal_tail_lines} ariaLabel="Journal tail lines" onChange={(value) => setSettings({ ...settings, journal_tail_lines: value })} />
                </FormField>
                <FormField label="Pinned KB limit">
                  <NumberStepper min={0} max={100} value={settings.kb_pinned_limit} ariaLabel="Pinned KB limit" onChange={(value) => setSettings({ ...settings, kb_pinned_limit: value })} />
                </FormField>
                <FormField label="Learning prompt limit">
                  <NumberStepper min={1} max={25} value={settings.agent_learning_injected_limit ?? 6} ariaLabel="Learning prompt limit" onChange={(value) => setSettings({ ...settings, agent_learning_injected_limit: value })} />
                </FormField>
                <FormField label="Auto-approve threshold">
                  <NumberStepper min={0} max={1} step={0.05} value={settings.agent_learning_auto_approve_threshold ?? 0.85} ariaLabel="Auto-approve threshold" onChange={(value) => setSettings({ ...settings, agent_learning_auto_approve_threshold: value })} />
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
            kicker={notificationSettingsState?.mode === "pwa" ? "Web Push" : "Browser"}
            title="Notifications"
            description="Browser or PWA notifications for Worklab activity."
            aside={<StatusPill status={notificationMeta.status} label={notificationMeta.label} />}
          >
            <SettingPanel icon="message-circle" title="Notifications" meta={notificationModeDetail} status={notificationMeta.status} statusLabel={notificationMeta.label}>
              <Switch
                checked={!!notificationSettingsState.enabled}
                disabled={notificationBusy || !notificationSettingsState.supported}
                onChange={updateBrowserNotifications}
                label="Notifications"
                description={notificationDescription(notificationSettingsState)}
              />
              <span class="settings-inline-status">
                {notificationDiagnosticText(notificationSettingsState, notificationServerStatus)}
              </span>
            </SettingPanel>
          </SettingsSection>

          <SettingsSection
            id="settings-assistant"
            kicker="Assistant"
            title="Assistant chat"
            description="Personal assistant model, memory identity, and agent robustness defaults."
            aside={<StatusPill status="enabled" label="Available" />}
          >
            <PanelGrid class="settings-panel-grid">
              <SettingPanel icon="sparkles" title="Run behavior" meta="Default model used by the assistant dock.">
                <FormGrid columns={2}>
                  <FormField label="Default model" class="span-2">
                    <Select
                      value={currentAssistantModel}
                      options={assistantModelOptions}
                      onChange={(value) => setSettings({ ...settings, assistant_model: value })}
                    />
                  </FormField>
                  <FormField label="Effort">
                    <Select
                      variant="native"
                      value={settings.assistant_effort || "high"}
                      options={SLACK_EFFORT_OPTIONS}
                      onChange={(value) => setSettings({ ...settings, assistant_effort: value })}
                    />
                  </FormField>
                  <FormField label="Run timeout (minutes)">
                    <DurationInput value={settings.assistant_run_timeout_ms} min={0.02} step={0.25} onChange={(value) => setSettings({ ...settings, assistant_run_timeout_ms: value })} ariaLabel="Assistant run timeout" />
                  </FormField>
                  <FormField label="Max turns">
                    <NumberStepper min={1} max={200} value={settings.assistant_max_turns ?? 32} ariaLabel="Assistant max turns" onChange={(value) => setSettings({ ...settings, assistant_max_turns: value })} />
                  </FormField>
                </FormGrid>
              </SettingPanel>
              <SettingPanel icon="database" title="Memory" meta="Uses the same durable identity as Slack.">
                <PanelGrid class="settings-note-grid">
                  <FieldNote
                    label="Memory name"
                    value={<AgentLink name={settings.slack_agent_name || "assistant"} agents={agents} />}
                    mono
                  />
                  <FieldNote label="Journal tail" value={`${settings.journal_tail_lines ?? 80} lines`} />
                </PanelGrid>
              </SettingPanel>
              <SettingPanel icon="terminal" title="Agent robustness" meta="Context compaction, tool budgets, and continuation limits." class="span-2">
                <SectionStack class="settings-switch-stack">
                  <Switch
                    checked={settings.agent_compaction_enabled !== false}
                    onChange={(next) => setSettings({ ...settings, agent_compaction_enabled: next })}
                    label="Context compaction"
                    description="Compact long transcripts before they exceed model context."
                  />
                  <Switch
                    checked={settings.delegation_enabled !== false}
                    onChange={(next) => setSettings({ ...settings, delegation_enabled: next })}
                    label="Native delegation"
                    description="Allow agents to create child tasks when work is separable."
                  />
                  <Switch
                    checked={settings.delegation_auto_run_children !== false}
                    onChange={(next) => setSettings({ ...settings, delegation_auto_run_children: next })}
                    label="Auto-run delegated children"
                    description="Start delegated child tasks automatically while respecting the parallel cap."
                  />
                </SectionStack>
                <AdvancedSettings summary="Budgets and recovery" count={5}>
                  <ControlGroupStack>
                    <ControlGroup title="Delegation" description="Limits for child-task fanout.">
                      <FormField label="Depth">
                        <NumberStepper min={0} max={10} value={settings.delegation_max_depth ?? 1} ariaLabel="Delegation depth" onChange={(value) => setSettings({ ...settings, delegation_max_depth: value })} />
                      </FormField>
                      <FormField label="Children per round">
                        <NumberStepper min={1} max={50} value={settings.delegation_max_children_per_round ?? 5} ariaLabel="Delegation children per round" onChange={(value) => setSettings({ ...settings, delegation_max_children_per_round: value })} />
                      </FormField>
                      <FormField label="Parallel children">
                        <NumberStepper min={1} max={50} value={settings.delegation_max_parallel_children ?? 3} ariaLabel="Delegation parallel children" onChange={(value) => setSettings({ ...settings, delegation_max_parallel_children: value })} />
                      </FormField>
                    </ControlGroup>

                    <ControlGroup title="Run turn budget" description="Default warning and hard-stop thresholds for new agent runs.">
                      <FormField label="Warn turns">
                        <NumberStepper min={1} max={10000} step={25} value={settings.agent_budget_soft_turns ?? 150} ariaLabel="Agent budget warning turns" onChange={(value) => setSettings({ ...settings, agent_budget_soft_turns: value })} />
                      </FormField>
                      <FormField label="Max turns">
                        <NumberStepper min={1} max={10000} step={25} value={settings.agent_budget_hard_turns ?? 300} ariaLabel="Agent budget max turns" onChange={(value) => setSettings({ ...settings, agent_budget_hard_turns: value })} />
                      </FormField>
                    </ControlGroup>

                    <ControlGroup title="Context compaction" description="Transcript compaction trigger and retained context size.">
                      <FormField label="Trigger ratio">
                        <NumberStepper min={0.2} max={0.95} step={0.01} value={settings.agent_compaction_trigger_ratio ?? 0.85} ariaLabel="Compaction trigger ratio" onChange={(value) => setSettings({ ...settings, agent_compaction_trigger_ratio: value })} />
                      </FormField>
                      <FormField label="Keep tokens">
                        <NumberStepper min={4000} max={200000} step={1000} value={settings.agent_compaction_keep_recent_tokens ?? 24000} ariaLabel="Keep recent tokens" onChange={(value) => setSettings({ ...settings, agent_compaction_keep_recent_tokens: value })} />
                      </FormField>
                      <FormField label="Summary tokens">
                        <NumberStepper min={1000} max={64000} step={1000} value={settings.agent_compaction_summary_max_tokens ?? 16000} ariaLabel="Compaction summary tokens" onChange={(value) => setSettings({ ...settings, agent_compaction_summary_max_tokens: value })} />
                      </FormField>
                      <FormField label="Min savings">
                        <NumberStepper min={0} max={500000} step={1000} value={settings.agent_compaction_min_savings_tokens ?? 20000} ariaLabel="Minimum compaction savings tokens" onChange={(value) => setSettings({ ...settings, agent_compaction_min_savings_tokens: value })} />
                      </FormField>
                    </ControlGroup>

                    <ControlGroup title="Tool output limits" description="Caps for large tool payloads before pruning, compaction, or artifact fallback.">
                      <FormField label="Compact chars">
                        <NumberStepper min={0} max={10485760} step={10000} value={settings.agent_tool_payload_compaction_trigger_chars ?? 0} ariaLabel="Tool payload compaction character trigger" onChange={(value) => setSettings({ ...settings, agent_tool_payload_compaction_trigger_chars: value })} />
                      </FormField>
                      <FormField label="Prune tokens">
                        <NumberStepper min={0} max={500000} step={1000} value={settings.agent_tool_prune_trigger_tokens ?? 40000} ariaLabel="Tool result prune token trigger" onChange={(value) => setSettings({ ...settings, agent_tool_prune_trigger_tokens: value })} />
                      </FormField>
                      <FormField label="Tool chars">
                        <NumberStepper min={1000} max={200000} step={1000} value={settings.agent_tool_text_limit_chars ?? 16000} ariaLabel="Tool text character limit" onChange={(value) => setSettings({ ...settings, agent_tool_text_limit_chars: value })} />
                      </FormField>
                      <FormField label="Bash chars">
                        <NumberStepper min={1000} max={200000} step={1000} value={settings.agent_bash_output_limit_chars ?? 20000} ariaLabel="Bash output character limit" onChange={(value) => setSettings({ ...settings, agent_bash_output_limit_chars: value })} />
                      </FormField>
                      <FormField label="MCP chars">
                        <NumberStepper min={1000} max={200000} step={1000} value={settings.agent_mcp_text_limit_chars ?? 12000} ariaLabel="MCP text character limit" onChange={(value) => setSettings({ ...settings, agent_mcp_text_limit_chars: value })} />
                      </FormField>
                      <FormField label="Search results">
                        <NumberStepper min={10} max={1000} step={10} value={settings.agent_search_result_limit ?? 100} ariaLabel="Search result limit" onChange={(value) => setSettings({ ...settings, agent_search_result_limit: value })} />
                      </FormField>
                      <FormField label="Image bytes">
                        <NumberStepper min={0} max={10485760} step={50000} value={settings.agent_image_inline_max_bytes ?? 250000} ariaLabel="Inline image byte limit" onChange={(value) => setSettings({ ...settings, agent_image_inline_max_bytes: value })} />
                      </FormField>
                      <FormField label="MCP timeout">
                        <DurationInput unit="seconds" value={settings.agent_mcp_call_timeout_ms ?? 120000} min={1} step={5} onChange={(value) => setSettings({ ...settings, agent_mcp_call_timeout_ms: value })} ariaLabel="MCP call timeout" />
                      </FormField>
                    </ControlGroup>

                    <ControlGroup title="Recovery and verification" description="Provider retry behavior and optional completion adjudication.">
                      <FormField label="Continuations">
                        <NumberStepper min={0} max={20} value={settings.agent_recovery_continuation_limit ?? 3} ariaLabel="Recovery continuation limit" onChange={(value) => setSettings({ ...settings, agent_recovery_continuation_limit: value })} />
                      </FormField>
                      <FormField switchInside class="span-2">
                        <Switch checked={settings.agent_provider_recovery_enabled !== false} onChange={(value) => setSettings({ ...settings, agent_provider_recovery_enabled: value })} label="Provider recovery" description="Retry transient provider failures automatically." />
                      </FormField>
                      <FormField label="Retry delay">
                        <DurationInput unit="seconds" value={settings.agent_provider_recovery_base_delay_ms ?? 30000} min={0} step={5} onChange={(value) => setSettings({ ...settings, agent_provider_recovery_base_delay_ms: value })} ariaLabel="Provider recovery base delay" />
                      </FormField>
                      <FormField label="Adjudicator">
                        <Select variant="native" value={settings.agent_verification_adjudicator_mode || "off"} options={VERIFICATION_ADJUDICATOR_MODE_OPTIONS} onChange={(value) => setSettings({ ...settings, agent_verification_adjudicator_mode: value })} />
                      </FormField>
                      <FormField label="Adjudicator model" class="span-2">
                        <Select
                          value={currentAdjudicatorModel}
                          options={adjudicatorModelOptions}
                          onChange={(value) => setSettings({ ...settings, agent_verification_adjudicator_model: value })}
                          placeholder="Select provider model"
                          ariaLabel="Verification adjudicator model"
                        />
                      </FormField>
                      <FormField label="Adjudicator timeout">
                        <DurationInput unit="seconds" value={settings.agent_verification_adjudicator_timeout_ms ?? 30000} min={1} step={5} onChange={(value) => setSettings({ ...settings, agent_verification_adjudicator_timeout_ms: value })} ariaLabel="Verification adjudicator timeout" />
                      </FormField>
                    </ControlGroup>
                  </ControlGroupStack>
                </AdvancedSettings>
              </SettingPanel>
            </PanelGrid>
          </SettingsSection>

          <SettingsSection
            id="settings-slack"
            kicker="Slack"
            title="Slack bot"
            description="Socket Mode bot for Slack triage and Worklab task notifications."
            aside={(
              <div class="settings-section-status">
                <StatusPill status={slackMeta.status} label={slackMeta.label} />
                {slackStatus?.bot_user_id && <span class="settings-inline-status">{slackStatus.bot_user_id}</span>}
              </div>
            )}
          >
            <PanelGrid class="settings-panel-grid">
              <SettingPanel icon="message-square" title="Delivery" meta="Bot intake and outbound DMs." status={slackMeta.status} statusLabel={slackMeta.label}>
                <SectionStack class="settings-switch-stack">
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
                </SectionStack>
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
            </PanelGrid>
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
              <PanelGrid class="settings-note-grid">
                <FieldNote label="Last inbound" value={slackStatus?.last_inbound?.received_at ? new Date(slackStatus.last_inbound.received_at).toLocaleString() : "-"} />
                <FieldNote label="Last rejected" value={slackRejectedSenderLabel(slackStatus)} mono />
                <FieldNote label="Last run" value={slackStatus?.last_run?.status || "-"} />
                <FieldNote label="Last delivery" value={slackStatus?.last_delivery?.status || "-"} />
              </PanelGrid>
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
            title="Knowledge search"
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
            kicker="MCP tools"
            title="MCP servers"
            description="Built-in servers are read-only. User servers are saved to the MCP config file."
            aside={<StatusPill status={mcpSummary.status} label={mcpSummary.label} />}
          >
            {mcpStatus?.config_error && <Banner variant="error" title="MCP config error" detail={mcpStatus.config_error} />}
            <PanelGrid class="settings-panel-grid">
              {builtinMcpServers.map((server) => {
                const health = mcpHealthResults[mcpHealthBuiltinKey(server.name)];
                const healthMeta = mcpHealthMeta(health);
                return (
                  <SettingPanel
                    key={server.name}
                    icon="terminal"
                    title={server.name}
                    meta={`${server.transport} / built-in`}
                    status={mcpAllBusy ? "running" : (healthMeta?.status || (server.available === false ? "error" : "enabled"))}
                    statusLabel={mcpAllBusy ? "Checking" : (healthMeta?.label || (server.available === false ? "Unavailable" : "Available"))}
                  >
                    <div class={`settings-inline-status ${health?.health === "ok" ? "ok" : health ? "error" : ""}`.trim()}>
                      {health ? mcpHealthDetail(health) : (server.unavailable_reason || "Ready for agent MCP allowlists.")}
                    </div>
                  </SettingPanel>
                );
              })}
              {builtinMcpServers.length === 0 && (
                <SettingPanel icon="terminal" title="Built-in servers" meta="No built-in MCP servers reported." status="disabled" statusLabel="None">
                  <div class="settings-inline-status">No built-in MCP servers are available.</div>
                </SettingPanel>
              )}
            </PanelGrid>
            <InlineHead class="settings-list-head">
              <div>
                <h3>External MCP servers</h3>
                <p>{mcpRows.length ? `${mcpRows.length} configured` : "No external servers configured"}</p>
              </div>
              <Toolbar class="settings-list-actions">
                <Button size="sm" variant="secondary" loading={mcpAllBusy} iconLeft={<Icon name="refresh-cw" size={12} />} onClick={checkAllMcpHealth}>Health check</Button>
                <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={12} />} onClick={addMcpRow}>Add MCP server</Button>
              </Toolbar>
            </InlineHead>
            <SectionStack class="settings-list">
              {mcpRows.length === 0 && <div class="settings-empty-note">External MCP servers can be added when an agent needs tools outside Worklab.</div>}
              {mcpRows.map((row) => {
                const serverStatus = userMcpStatusByName.get(row.name);
                const healthKey = mcpHealthRowKey(row.id);
                const rowHealth = mcpHealthResults[healthKey];
                const rowHealthMeta = mcpHealthMeta(rowHealth);
                const rowBusy = !!mcpHealthBusy[healthKey] || mcpAllBusy;
                const status = row.name
                  ? (serverStatus?.available === false ? "error" : "enabled")
                  : "disabled";
                const statusLabel = row.name
                  ? (serverStatus?.available === false ? "Unavailable" : "Configured")
                  : "Draft";
                return (
                <div class="settings-admin-row settings-mcp-row" key={row.id}>
                  <InlineHead class="settings-mcp-head">
                    <div>
                      <strong>{row.name || "New MCP server"}</strong>
                      <div class="settings-row-sub">{row.transport} / external</div>
                    </div>
                    <Toolbar class="settings-row-actions">
                      <StatusPill status={rowBusy ? "running" : (rowHealthMeta?.status || status)} label={rowBusy ? "Checking" : (rowHealthMeta?.label || statusLabel)} size="sm" />
                      <Button variant="secondary" size="sm" loading={!!mcpHealthBusy[healthKey]} disabled={mcpAllBusy} iconLeft={<Icon name="check-circle" size={12} />} onClick={() => checkMcpRowHealth(row)}>Check</Button>
                      <Button variant="destructive" size="sm" iconLeft={<Icon name="trash" size={12} />} onClick={() => deleteMcpRow(row.id)}>Delete</Button>
                    </Toolbar>
                  </InlineHead>
                  {rowHealth && <div class={`settings-health-note ${rowHealth.health}`.trim()}>{mcpHealthDetail(rowHealth)}</div>}
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
            </SectionStack>
          </SettingsSection>

        </div>
      </Page>
    </AppShell>
  );
}
