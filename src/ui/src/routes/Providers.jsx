import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { AppShell } from "../components/AppShell.jsx";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { SwitchField } from "../components/SwitchField.jsx";
import { SelectField } from "../components/SelectField.jsx";
import { Icon } from "../components/Icon.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";

const PROVIDER_TYPE_OPTIONS = [
  { value: "ollama", label: "Ollama", helper: "Local / LAN" },
  { value: "lmstudio", label: "LM Studio", helper: "Local / LAN" },
  { value: "vllm", label: "vLLM", helper: "Self-hosted" },
  { value: "openai_compat", label: "OpenAI-compatible", helper: "Custom gateway" },
  { value: "groq", label: "Groq", helper: "Hosted" },
  { value: "openrouter", label: "OpenRouter", helper: "Hosted" },
  { value: "together", label: "Together AI", helper: "Hosted" },
  { value: "fireworks", label: "Fireworks AI", helper: "Hosted" },
  { value: "deepseek", label: "DeepSeek", helper: "Hosted" },
];

const PRESETS = {
  ollama: { name: "Ollama (local)", base_url: "http://localhost:11434", trust_public_url: false, api_key_hint: "No API key needed for most local setups." },
  lmstudio: { name: "LM Studio", base_url: "http://localhost:1234", trust_public_url: false, api_key_hint: "Usually no API key." },
  vllm: { name: "vLLM", base_url: "http://localhost:8000", trust_public_url: false, api_key_hint: "Often fronted by an internal gateway." },
  openai_compat: { name: "Custom gateway", base_url: "", trust_public_url: false, api_key_hint: "Any OpenAI-compatible host." },
  groq: { name: "Groq", base_url: "https://api.groq.com/openai", trust_public_url: true, api_key_hint: "API key required." },
  openrouter: { name: "OpenRouter", base_url: "https://openrouter.ai/api", trust_public_url: true, api_key_hint: "API key required." },
  together: { name: "Together AI", base_url: "https://api.together.xyz", trust_public_url: true, api_key_hint: "API key required." },
  fireworks: { name: "Fireworks AI", base_url: "https://api.fireworks.ai/inference", trust_public_url: true, api_key_hint: "API key required." },
  deepseek: { name: "DeepSeek", base_url: "https://api.deepseek.com", trust_public_url: true, api_key_hint: "API key required." },
};

const emptyForm = {
  name: PRESETS.ollama.name,
  provider_type: "ollama",
  base_url: PRESETS.ollama.base_url,
  api_key: "",
  trust_public_url: PRESETS.ollama.trust_public_url,
  enabled: true,
};

function optionForProviderType(value) {
  return PROVIDER_TYPE_OPTIONS.find((o) => o.value === value) || { value, label: `Unsupported (${value})`, helper: "Unsupported" };
}

function applyPreset(form, providerType) {
  const previous = PRESETS[form.provider_type] || PRESETS.openai_compat;
  const next = PRESETS[providerType] || PRESETS.openai_compat;
  return {
    ...form,
    provider_type: providerType,
    name: !form.name || form.name === previous.name ? next.name : form.name,
    base_url: !form.base_url || form.base_url === previous.base_url ? next.base_url : form.base_url,
    trust_public_url: next.trust_public_url,
  };
}

function CapabilityBadge({ on, label, offLabel }) {
  return (
    <span class={`chip ${on ? "chip-accent" : "chip-ghost"}`} style={{ marginRight: 4 }}>
      {on ? label : (offLabel || `no ${label}`)}
    </span>
  );
}

export function Providers() {
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState({});
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState({});
  const [showNew, setShowNew] = useState(false);
  const preset = PRESETS[form.provider_type] || PRESETS.openai_compat;

  const load = useCallback(async () => {
    const res = await api.listProviders();
    setProviders(res.providers || []);
    const pairs = await Promise.all((res.providers || []).map(async (p) => {
      try {
        const m = await api.listProviderModels(p.id);
        return [p.id, m.models || []];
      } catch { return [p.id, []]; }
    }));
    setModels(Object.fromEntries(pairs));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    setError(null);
    try {
      await api.createProvider({ ...form, api_key: form.api_key || undefined });
      setForm(emptyForm);
      setShowNew(false);
      await load();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function patch(provider, p) {
    await api.patchProvider(provider.id, p);
    await load();
  }

  async function test(provider) {
    setError(null);
    setStatus((s) => ({ ...s, [provider.id]: { ...(s[provider.id] || {}), testing: true } }));
    try {
      const result = await api.testProvider(provider.id);
      setStatus((s) => ({ ...s, [provider.id]: { testing: false, test: result } }));
    } catch (err) {
      setStatus((s) => ({ ...s, [provider.id]: { testing: false, test: { ok: false, error: err.message } } }));
    }
  }

  async function discover(provider) {
    setError(null);
    setStatus((s) => ({ ...s, [provider.id]: { ...(s[provider.id] || {}), discovering: true } }));
    try {
      const result = await api.discoverProviderModels(provider.id);
      setStatus((s) => ({ ...s, [provider.id]: { discovering: false, discovery: { count: (result.models || []).length } } }));
      await load();
    } catch (err) {
      setStatus((s) => ({ ...s, [provider.id]: { discovering: false, discovery: { error: err.message } } }));
    }
  }

  async function remove(provider) {
    try {
      await api.deleteProvider(provider.id);
      await load();
    } catch (err) {
      setError(`${provider.name}: ${err.message}`);
    }
  }

  const headerMeta = (
    <>
      <span>{providers.length} configured</span>
      <span class="dot">·</span>
      <span>{providers.filter((p) => p.enabled).length} enabled</span>
    </>
  );

  const headerActions = (
    <button class="button primary" onClick={() => setShowNew((v) => !v)}>
      <Icon name="plus" size={13} />
      {showNew ? "Hide form" : "New provider"}
    </button>
  );

  return (
    <AppShell route="providers" title="Providers" headerMeta={headerMeta} headerActions={headerActions}>
      <div class="page-wrap">
        {error && <div class="form-error">{error}</div>}

        {showNew && (
          <section class="surface-panel">
            <div class="section-kicker">Create</div>
            <h3>New provider</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, marginBottom: 12 }}>
              {PROVIDER_TYPE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  class={`filter-pill ${form.provider_type === o.value ? "active" : ""}`}
                  onClick={() => setForm((c) => applyPreset(c, o.value))}
                  style={{ flexDirection: "column", height: "auto", padding: 10, alignItems: "flex-start", justifyContent: "center" }}
                >
                  <strong style={{ fontSize: 12.5 }}>{o.label}</strong>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{o.helper}</span>
                </button>
              ))}
            </div>
            <div class="form-grid">
              <div class="field">
                <label class="field-label">Name</label>
                <input class="form-input" value={form.name} onInput={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div class="field">
                <label class="field-label">Type</label>
                <SelectField
                  value={form.provider_type}
                  options={PROVIDER_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                  onChange={(v) => setForm((c) => applyPreset(c, v))}
                />
              </div>
              <div class="field span-2">
                <label class="field-label">Base URL</label>
                <input class="form-input" value={form.base_url} placeholder={preset.base_url || "https://..."} onInput={(e) => setForm({ ...form, base_url: e.target.value })} />
              </div>
              <div class="field span-2">
                <label class="field-label">API key (write-only)</label>
                <input class="form-input" type="password" autocomplete="new-password" value={form.api_key} onInput={(e) => setForm({ ...form, api_key: e.target.value })} />
                <span class="field-hint">{preset.api_key_hint}</span>
              </div>
              <div class="field">
                <SwitchField checked={form.trust_public_url} onChange={(e) => setForm({ ...form, trust_public_url: e.target.checked })}>
                  Trust public HTTPS URL
                </SwitchField>
              </div>
              <div class="field">
                <SwitchField checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })}>
                  Show in model pickers
                </SwitchField>
              </div>
            </div>
            <div class="form-actions">
              <button class="button ghost" onClick={() => setShowNew(false)}>Cancel</button>
              <button class="button primary" onClick={create} disabled={!form.name || !form.base_url}>
                <Icon name="plus" size={13} />
                Create provider
              </button>
            </div>
          </section>
        )}

        {providers.length === 0 && !showNew && (
          <div class="empty-state">
            <Icon name="terminal" size={28} />
            <h3>No providers yet</h3>
            <p>Add a provider to use local or hosted models.</p>
            <button class="button primary" onClick={() => setShowNew(true)}>
              <Icon name="plus" size={13} />
              Add first provider
            </button>
          </div>
        )}

        {providers.map((provider) => {
          const s = status[provider.id] || {};
          return (
            <section class="surface-panel" key={provider.id}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ margin: "0 0 4px" }}>{provider.name}</h3>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>
                    {optionForProviderType(provider.provider_type).label} · {provider.base_url} · {provider.has_api_key ? "API key saved" : "no API key"}
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <StatusPill status={provider.enabled ? "enabled" : "disabled"} size="sm" />
                  </div>
                  {s.test && (
                    <div style={{ marginTop: 6, color: s.test.ok ? "var(--green)" : "var(--red)", fontSize: 12 }}>
                      {s.test.ok
                        ? `Reachable (${s.test.status}) in ${s.test.duration_ms ?? 0}ms`
                        : `Unreachable: ${s.test.error || `HTTP ${s.test.status}`}`}
                    </div>
                  )}
                  {s.discovery && (
                    <div style={{ marginTop: 6, color: s.discovery.error ? "var(--red)" : "var(--green)", fontSize: 12 }}>
                      {s.discovery.error ? `Discovery failed: ${s.discovery.error}` : `Discovered ${s.discovery.count} model${s.discovery.count === 1 ? "" : "s"}.`}
                    </div>
                  )}
                </div>
                <div class="toolbar">
                  <button class="button small" onClick={() => patch(provider, { enabled: !provider.enabled })}>
                    {provider.enabled ? "Disable" : "Enable"}
                  </button>
                  <button class="button small" onClick={() => test(provider)} disabled={s.testing}>
                    <Icon name="check-circle" size={12} />
                    {s.testing ? "Testing..." : "Test"}
                  </button>
                  <button class="button small" onClick={() => discover(provider)} disabled={s.discovering}>
                    <Icon name="refresh-cw" size={12} />
                    {s.discovering ? "Discovering..." : "Discover"}
                  </button>
                  <ConfirmButton class="button danger small" onConfirm={() => remove(provider)} confirmLabel="Click again to delete">
                    Delete
                  </ConfirmButton>
                </div>
              </div>
              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 8 }}>
                {(models[provider.id] || []).map((model) => {
                  const caps = model.capabilities || {};
                  const runnable = caps.runnable_for_agent !== false;
                  return (
                    <div key={model.id} class="surface-panel compact" style={{ background: "var(--surface-muted)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <strong style={{ fontSize: 12.5 }}>{model.display_name || model.model_name}</strong>
                          <div style={{ color: "var(--muted)", fontSize: 11, fontFamily: "var(--mono)" }}>{model.model_name}</div>
                          <div style={{ marginTop: 4 }}>
                            <CapabilityBadge on={runnable} label="chat" />
                            <CapabilityBadge on={caps.tool_use} label="tools" />
                            <CapabilityBadge on={caps.reasoning} label={caps.reasoning_mode === "toggle" ? "thinking" : "reasoning"} />
                            <CapabilityBadge on={caps.vision} label="vision" />
                            <CapabilityBadge on={caps.json_mode} label="json" />
                          </div>
                        </div>
                        <button
                          class="button small"
                          disabled={!model.enabled && !runnable}
                          onClick={() => api.patchProviderModel(provider.id, model.id, { enabled: !model.enabled }).then(load)}
                        >
                          {!model.enabled && !runnable ? "Not runnable" : (model.enabled ? "Disable" : "Enable")}
                        </button>
                      </div>
                    </div>
                  );
                })}
                {(models[provider.id] || []).length === 0 && (
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>No models discovered yet.</div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
