import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { navigateHash } from "../lib/navigation.js";
import { AppShell } from "../components/AppShell.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Icon } from "../components/Icon.jsx";
import { modelDisplayName } from "../lib/display.js";

const LOG_LEVEL_OPTIONS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"].map((value) => ({ value, label: value }));
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

function numberOrEmpty(value) {
  if (value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
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

function modelOptionsFromGroups(groups = []) {
  return groups.map((group) => ({
    label: group.available === false ? `${group.label} (unavailable)` : group.label,
    options: (group.models || []).map((model) => ({
      value: model.value,
      label: model.label || model.value,
      description: model.description || undefined,
      disabled: group.available === false || model.available === false || model.disabled === true,
    })),
  }));
}

function flattenModels(groups = []) {
  return groups.flatMap((group) => (group.models || []).map((model) => ({ ...model, group: group.label })));
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

function ProviderStatus({ status }) {
  if (!status) return null;
  if (status.kind === "testing") return <span class="settings-inline-status">Testing...</span>;
  if (status.kind === "discovering") return <span class="settings-inline-status">Discovering...</span>;
  if (status.kind === "error") return <span class="settings-inline-status error">{status.message}</span>;
  if (status.kind === "test") return <span class={`settings-inline-status ${status.result?.ok ? "ok" : "error"}`.trim()}>{status.result?.ok ? "Reachable" : "Unreachable"}</span>;
  if (status.kind === "discovered") return <span class="settings-inline-status ok">{status.count} models</span>;
  return null;
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
  const [providers, setProviders] = useState([]);
  const [providerModels, setProviderModels] = useState({});
  const [providerStatus, setProviderStatus] = useState({});
  const [mcpStatus, setMcpStatus] = useState(null);
  const [mcpRows, setMcpRows] = useState([]);
  const [mcpBaselineRows, setMcpBaselineRows] = useState([]);
  const [agents, setAgents] = useState([]);
  const [modelGroups, setModelGroups] = useState([]);
  const [restarting, setRestarting] = useState(false);

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

  const loadProviders = useCallback(async () => {
    const response = await api.listProviders();
    const nextProviders = response.providers || [];
    setProviders(nextProviders);
    const entries = await Promise.all(nextProviders.map(async (provider) => {
      try {
        const models = await api.listProviderModels(provider.id);
        return [provider.id, models.models || []];
      } catch {
        return [provider.id, []];
      }
    }));
    setProviderModels(Object.fromEntries(entries));
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

  const loadAgents = useCallback(async () => {
    const [agentResponse, modelResponse] = await Promise.all([
      api.listAgents().catch(() => ({ agents: [] })),
      api.listAvailableModels().catch(() => ({ groups: [] })),
    ]);
    setAgents(agentResponse.agents || []);
    setModelGroups(modelResponse.groups || []);
  }, []);

  useEffect(() => {
    loadSettings().catch((err) => pushToast(`Settings failed: ${err.message}`, { variant: "error" }));
    loadRuntime();
    api.searchStatus().then((r) => setIndexStatus(r.status)).catch(() => setIndexStatus(null));
    api.listEmbeddingModels().then((r) => setEmbeddingGroups(r.groups || [])).catch(() => setEmbeddingGroups([]));
    loadProviders().catch((err) => pushToast(`Providers failed: ${err.message}`, { variant: "error" }));
    loadMcp().catch((err) => pushToast(`MCP failed: ${err.message}`, { variant: "error" }));
    loadAgents().catch((err) => pushToast(`Agents failed: ${err.message}`, { variant: "error" }));
  }, [loadAgents, loadMcp, loadProviders, loadRuntime, loadSettings]);

  const settingsDirty = useMemo(() => baseline ? !jsonEqual(settings, baseline) : false, [settings, baseline]);
  const runtimeDirty = useMemo(() => runtimeBaseline ? !jsonEqual(runtimeDraft, runtimeBaseline) : false, [runtimeDraft, runtimeBaseline]);
  const mcpDirty = useMemo(() => !jsonEqual(mcpRows, mcpBaselineRows), [mcpRows, mcpBaselineRows]);
  const isDirty = settingsDirty || runtimeDirty || mcpDirty;

  const formSave = useFormSave(async () => {
    if (settingsDirty) {
      const response = await api.patchSettings(settingsPayload(settings));
      setSettings(response.settings);
      setBaseline(response.settings);
    }
    if (runtimeDirty) {
      await api.patchRuntimeSettings(runtimePayload(runtimeDraft));
      await loadRuntime();
    }
    if (mcpDirty) {
      await api.putMcpConfig({ mcpServers: mcpServersFromRows(mcpRows) });
      await loadMcp();
      await loadAgents();
    }
    pushToast("Saved.", { variant: "success" });
  });

  useGlobalShortcuts({
    cmds: (event) => { event.preventDefault(); formSave.save().catch(() => {}); },
  });

  const currentEmbedding = settings?.default_embedding_model || "";
  const allEmbeddingValues = embeddingGroups.flatMap((g) => (g.models || []).map((m) => m.value));
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

  const modelOptions = modelOptionsFromGroups(modelGroups);
  const modelRows = flattenModels(modelGroups);

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

  async function toggleProvider(provider, enabled) {
    try {
      await api.patchProvider(provider.id, { enabled });
      await loadProviders();
      await loadAgents();
    } catch (err) {
      pushToast(`Provider update failed: ${err.message}`, { variant: "error" });
    }
  }

  async function providerAction(provider, action) {
    const key = `${provider.id}:${action}`;
    setProviderStatus((current) => ({ ...current, [provider.id]: { kind: action === "test" ? "testing" : "discovering" } }));
    try {
      if (action === "test") {
        const result = await api.testProvider(provider.id);
        setProviderStatus((current) => ({ ...current, [provider.id]: { kind: "test", result } }));
      } else {
        const result = await api.discoverProviderModels(provider.id);
        setProviderModels((current) => ({ ...current, [provider.id]: result.models || [] }));
        setProviderStatus((current) => ({ ...current, [provider.id]: { kind: "discovered", count: (result.models || []).length } }));
        await loadAgents();
      }
    } catch (err) {
      setProviderStatus((current) => ({ ...current, [provider.id]: { kind: "error", message: err.message, key } }));
    }
  }

  async function toggleModel(provider, model) {
    try {
      await api.patchProviderModel(provider.id, model.id, { enabled: !model.enabled });
      const response = await api.listProviderModels(provider.id);
      setProviderModels((current) => ({ ...current, [provider.id]: response.models || [] }));
      await loadAgents();
    } catch (err) {
      pushToast(`Model update failed: ${err.message}`, { variant: "error" });
    }
  }

  async function toggleAgent(agent, enabled) {
    try {
      const response = await api.patchAgent(agent.name, { enabled });
      setAgents((current) => current.map((item) => item.name === agent.name ? response.agent : item));
    } catch (err) {
      pushToast(`Agent update failed: ${err.message}`, { variant: "error" });
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

  if (!settings || !runtimeDraft) {
    return (
      <AppShell route="settings">
        <div class="page-wrap"><LoadingState caption="Loading settings..." /></div>
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

  return (
    <AppShell route="settings">
      <div class="page-wrap">
        <div class="page-actions toolbar">{pageActions}</div>
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

        <div class="settings-sections">
          <FormSection kicker="Runtime" title="Service runtime" description="Values written here apply after the Worklab service restarts. Timeout durations are shown in minutes.">
            <FormGrid columns={3}>
              <FormField label="Host">
                <Input disabled={!!runtimeError} value={runtimeDraft.host} onInput={(event) => setRuntimeDraft({ ...runtimeDraft, host: event.target.value })} />
              </FormField>
              <FormField label="Port">
                <Input disabled={!!runtimeError} type="number" min="1" max="65535" value={runtimeDraft.port} onInput={(event) => setRuntimeDraft({ ...runtimeDraft, port: numberOrEmpty(event.target.value) })} />
              </FormField>
              <FormField label="Log level">
                <Select disabled={!!runtimeError} variant="native" value={runtimeDraft.logLevel} options={LOG_LEVEL_OPTIONS} onChange={(value) => setRuntimeDraft({ ...runtimeDraft, logLevel: value })} />
              </FormField>
              <FormField label="Workspace" class="span-2">
                <Input disabled={!!runtimeError} value={runtimeDraft.workspace} onInput={(event) => setRuntimeDraft({ ...runtimeDraft, workspace: event.target.value })} />
              </FormField>
              <FormField label="Timezone">
                <Input disabled={!!runtimeError} value={runtimeDraft.timezone || ""} placeholder="system local time" onInput={(event) => setRuntimeDraft({ ...runtimeDraft, timezone: event.target.value })} />
              </FormField>
              <FormField label="Idle warning (minutes)">
                <Input disabled={!!runtimeError} type="number" min="0" step="0.01" value={minutesValue(runtimeDraft.runIdleWarningMs)} onInput={(event) => setRuntimeDraft({ ...runtimeDraft, runIdleWarningMs: minutesToMs(event.target.value) })} />
              </FormField>
              <FormField label="Inline log limit (chars)">
                <Input disabled={!!runtimeError} type="number" min="0" value={runtimeDraft.logInlineLimit} onInput={(event) => setRuntimeDraft({ ...runtimeDraft, logInlineLimit: numberOrEmpty(event.target.value) })} />
              </FormField>
            </FormGrid>
            <div class="settings-note-grid">
              <FieldNote label="Data directory" value={runtime?.readOnly?.dataDir} mono />
              <FieldNote label="Repository" value={runtime?.readOnly?.repoRoot} mono />
              <FieldNote label="Service" value={runtime?.service?.installed ? `installed (${runtime.service.platform})` : "not installed"} />
            </div>
          </FormSection>

          <FormSection kicker="Execution" title="Workers and memory" description="Global limits and context controls used by new agent runs.">
            <FormGrid columns={3}>
              <FormField label="Worker timeout (minutes)">
                <Input type="number" min="0.02" step="0.01" value={minutesValue(settings.worker_timeout_ms)} onInput={(event) => setSettings({ ...settings, worker_timeout_ms: minutesToMs(event.target.value) })} />
              </FormField>
              <FormField label="Cancel grace (minutes)">
                <Input type="number" min="0" step="0.01" value={minutesValue(settings.cancel_grace_ms)} onInput={(event) => setSettings({ ...settings, cancel_grace_ms: minutesToMs(event.target.value) })} />
              </FormField>
              <FormField label="Consolidation hour">
                <Input type="number" min="0" max="23" value={settings.consolidation_hour} onInput={(event) => setSettings({ ...settings, consolidation_hour: event.target.value })} />
              </FormField>
              <FormField label="Journal tail lines">
                <Input type="number" min="0" max="1000" value={settings.journal_tail_lines} onInput={(event) => setSettings({ ...settings, journal_tail_lines: event.target.value })} />
              </FormField>
              <FormField label="Pinned KB limit">
                <Input type="number" min="0" max="100" value={settings.kb_pinned_limit} onInput={(event) => setSettings({ ...settings, kb_pinned_limit: event.target.value })} />
              </FormField>
              <FormField switchInside>
                <Switch
                  checked={!!settings.consolidation_enabled}
                  onChange={(next) => setSettings({ ...settings, consolidation_enabled: next })}
                  label="Nightly consolidation"
                  description="Refresh agent memory once per day."
                />
              </FormField>
            </FormGrid>
          </FormSection>

          <FormSection kicker="Search" title="Embeddings" description="Controls which embedding model is used to index knowledge and journals.">
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
            {indexStatus && (
              <div class={`settings-index-status ${indexStatus.errors ? "has-errors" : ""}`}>
                Search index: {indexStatus.total} chunks / {indexStatus.vectorized} vectorized / {indexStatus.errors} errors / {indexStatus.model || "-"}
                {indexStatus.model && !indexStatus.ready && ` / paused (${indexStatus.reason || "provider not configured"})`}
              </div>
            )}
          </FormSection>

          <FormSection kicker="Models" title="Providers and discovered models" description="Enable providers and models that should appear in agent and embedding pickers.">
            <div class="settings-list">
              {providers.length === 0 ? (
                <div class="field-hint">No custom providers configured.</div>
              ) : providers.map((provider) => (
                <div class="settings-admin-row" key={provider.id}>
                  <div class="settings-admin-row-head">
                    <div class="min-w-0">
                      <strong>{provider.name}</strong>
                      <div class="settings-row-sub mono">{provider.base_url}</div>
                    </div>
                    <div class="settings-row-actions">
                      <ProviderStatus status={providerStatus[provider.id]} />
                      <Switch checked={!!provider.enabled} onChange={(next) => toggleProvider(provider, next)} label={provider.enabled ? "Enabled" : "Disabled"} />
                      <Button size="sm" variant="secondary" onClick={() => providerAction(provider, "test")}>Test</Button>
                      <Button size="sm" variant="secondary" onClick={() => providerAction(provider, "discover")}>Discover</Button>
                      <Button size="sm" variant="ghost" onClick={() => navigateHash(`#/providers/${provider.id}`)}>Edit</Button>
                    </div>
                  </div>
                  <div class="settings-model-grid">
                    {(providerModels[provider.id] || []).map((model) => (
                      <div class="settings-model-row" key={model.id}>
                        <div class="min-w-0">
                          <strong>{model.display_name || model.model_name}</strong>
                          <div class="settings-row-sub mono">{model.model_name}</div>
                        </div>
                        <div class="settings-row-actions">
                          {model.capabilities?.embedding && <Chip variant="accent">Embedding</Chip>}
                          {model.capabilities?.runnable_for_agent !== false && <Chip variant="tag">Chat</Chip>}
                          <Switch checked={!!model.enabled} onChange={() => toggleModel(provider, model)} label={model.enabled ? "Enabled" : "Disabled"} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </FormSection>

          <FormSection kicker="Tools" title="MCP servers" description="Built-in servers are read-only. User servers are saved to the MCP config file.">
            {mcpStatus?.config_error && <Banner variant="error" title="MCP config error" detail={mcpStatus.config_error} />}
            <div class="settings-list">
              {(mcpStatus?.servers || []).filter((server) => server.source === "builtin").map((server) => (
                <div class="settings-admin-row compact" key={server.name}>
                  <div>
                    <strong>{server.name}</strong>
                    <div class="settings-row-sub">{server.transport} / built-in</div>
                  </div>
                  <StatusPill status={server.available === false ? "error" : "enabled"} label={server.available === false ? "Unavailable" : "Available"} />
                </div>
              ))}
              {mcpRows.map((row) => (
                <div class="settings-admin-row" key={row.id}>
                  <FormGrid columns={3}>
                    <FormField label="Name">
                      <Input value={row.name} onInput={(event) => updateMcpRow(row.id, { name: event.target.value })} />
                    </FormField>
                    <FormField label="Transport">
                      <Select variant="native" value={row.transport} options={MCP_TRANSPORT_OPTIONS} onChange={(value) => updateMcpRow(row.id, { transport: value })} />
                    </FormField>
                    <FormField label="Action">
                      <Button variant="destructive" size="sm" onClick={() => setMcpRows((rows) => rows.filter((item) => item.id !== row.id))}>Delete</Button>
                    </FormField>
                    {row.transport === "stdio" ? (
                      <>
                        <FormField label="Command" class="span-2">
                          <Input value={row.command} onInput={(event) => updateMcpRow(row.id, { command: event.target.value })} placeholder="/absolute/path/to/server" />
                        </FormField>
                        <FormField label="Args (one per line)">
                          <Textarea rows={3} value={row.argsText} onInput={(event) => updateMcpRow(row.id, { argsText: event.target.value })} />
                        </FormField>
                        <FormField label="Env JSON" class="span-3">
                          <Textarea rows={3} monospace value={row.envText} onInput={(event) => updateMcpRow(row.id, { envText: event.target.value })} placeholder='{"KEY":"value"}' />
                        </FormField>
                      </>
                    ) : (
                      <>
                        <FormField label="URL" class="span-2">
                          <Input value={row.url} onInput={(event) => updateMcpRow(row.id, { url: event.target.value })} placeholder="http://localhost:3000/mcp" />
                        </FormField>
                        <FormField label="Headers JSON">
                          <Textarea rows={3} monospace value={row.headersText} onInput={(event) => updateMcpRow(row.id, { headersText: event.target.value })} placeholder='{"Authorization":"Bearer ..."}' />
                        </FormField>
                      </>
                    )}
                  </FormGrid>
                </div>
              ))}
            </div>
            <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={12} />} onClick={addMcpRow}>Add MCP server</Button>
          </FormSection>

          <FormSection kicker="Agents" title="Agent runtime inventory" description="Common agent runtime choices are summarized here; detailed prompts and allowlists stay on each agent page.">
            <div class="settings-list">
              {agents.length === 0 ? (
                <div class="field-hint">No agents configured.</div>
              ) : agents.map((agent) => {
                const selectedModel = modelRows.find((model) => model.value === agent.model);
                const availableSkills = agent.skills_allowlist_mode === "custom" ? agent.skills_allowlist.length : "all";
                const availableMcp = agent.mcp_allowlist_mode === "custom" ? agent.mcp_allowlist.length : "all";
                return (
                  <div class="settings-admin-row compact" key={agent.name}>
                    <div class="min-w-0">
                      <strong>{agent.display_name || agent.name}</strong>
                      <div class="settings-row-sub">
                        {modelDisplayName(agent.model, modelOptions)} / effort {agent.effort || "medium"} / skills {availableSkills} / MCP {availableMcp}
                        {selectedModel?.available === false && " / model unavailable"}
                      </div>
                    </div>
                    <div class="settings-row-actions">
                      <Switch checked={!!agent.enabled} onChange={(next) => toggleAgent(agent, next)} label={agent.enabled ? "Enabled" : "Disabled"} />
                      <Button size="sm" variant="ghost" onClick={() => navigateHash(`#/agents/${agent.name}`)}>Edit</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </FormSection>
        </div>
      </div>
    </AppShell>
  );
}
