// §6.8 Providers — provider configuration and model discovery.
// Type selector is a RadioGroup segmented (§6.8 rule) — not the prior flex-pill grid.

import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { AppShell } from "../components/AppShell.jsx";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { RadioGroup } from "../components/primitives/RadioGroup.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { Icon } from "../components/Icon.jsx";
import { Card } from "../components/Card.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { Banner } from "../components/Banner.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { pushToast } from "../lib/toast.js";

const PROVIDER_TYPE_OPTIONS = [
  { value: "ollama",        label: "Ollama",     helper: "Local / LAN" },
  { value: "lmstudio",      label: "LM Studio",  helper: "Local / LAN" },
  { value: "vllm",          label: "vLLM",       helper: "Self-hosted" },
  { value: "openai_compat", label: "OpenAI-compatible", helper: "Custom gateway" },
  { value: "groq",          label: "Groq",       helper: "Hosted" },
  { value: "openrouter",    label: "OpenRouter", helper: "Hosted" },
  { value: "together",      label: "Together AI", helper: "Hosted" },
  { value: "fireworks",     label: "Fireworks AI", helper: "Hosted" },
  { value: "deepseek",      label: "DeepSeek",   helper: "Hosted" },
];

const PRESETS = {
  ollama:        { name: "Ollama (local)", base_url: "http://localhost:11434", trust_public_url: false, api_key_hint: "No API key needed for most local setups." },
  lmstudio:      { name: "LM Studio",      base_url: "http://localhost:1234",  trust_public_url: false, api_key_hint: "Usually no API key." },
  vllm:          { name: "vLLM",           base_url: "http://localhost:8000",  trust_public_url: false, api_key_hint: "Often fronted by an internal gateway." },
  openai_compat: { name: "Custom gateway", base_url: "",                        trust_public_url: false, api_key_hint: "Any OpenAI-compatible host." },
  groq:          { name: "Groq",           base_url: "https://api.groq.com/openai", trust_public_url: true, api_key_hint: "API key required." },
  openrouter:    { name: "OpenRouter",     base_url: "https://openrouter.ai/api",   trust_public_url: true, api_key_hint: "API key required." },
  together:      { name: "Together AI",    base_url: "https://api.together.xyz",    trust_public_url: true, api_key_hint: "API key required." },
  fireworks:     { name: "Fireworks AI",   base_url: "https://api.fireworks.ai/inference", trust_public_url: true, api_key_hint: "API key required." },
  deepseek:      { name: "DeepSeek",       base_url: "https://api.deepseek.com",    trust_public_url: true, api_key_hint: "API key required." },
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

function Capability({ on, label, offLabel }) {
  return (
    <Chip variant={on ? "accent" : "ghost"}>
      {on ? label : (offLabel || `no ${label}`)}
    </Chip>
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
      try { const m = await api.listProviderModels(p.id); return [p.id, m.models || []]; }
      catch { return [p.id, []]; }
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
      pushToast("Provider created", { variant: "success" });
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
    try { await api.deleteProvider(provider.id); pushToast("Provider deleted", { variant: "success" }); await load(); }
    catch (err) { setError(`${provider.name}: ${err.message}`); }
  }

  const headerActions = (
    <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => setShowNew((v) => !v)}>
      {showNew ? "Hide form" : "New provider"}
    </Button>
  );

  return (
    <AppShell route="providers" title="Providers" headerActions={headerActions}>
      <div class="page-wrap">
        {error && <Banner variant="error" title="Action failed" detail={error} onDismiss={() => setError(null)} />}

        {showNew && (
          <Card kicker="Create" title="New provider">
            <FormSection title="">
              <FormField label="Type" hint={PROVIDER_TYPE_OPTIONS.find((o) => o.value === form.provider_type)?.helper}>
                <RadioGroup
                  ariaLabel="Provider type"
                  value={form.provider_type}
                  onChange={(v) => setForm((c) => applyPreset(c, v))}
                  options={PROVIDER_TYPE_OPTIONS}
                />
              </FormField>
              <FormGrid columns={2}>
                <FormField label="Name" required>
                  <Input value={form.name} onInput={(e) => setForm({ ...form, name: e.target.value })} />
                </FormField>
                <FormField label="Base URL" required>
                  <Input
                    value={form.base_url}
                    placeholder={preset.base_url || "https://..."}
                    onInput={(e) => setForm({ ...form, base_url: e.target.value })}
                  />
                </FormField>
                <FormField label="API key" hint={preset.api_key_hint} class="span-2">
                  <Input
                    type="password"
                    autocomplete="new-password"
                    value={form.api_key}
                    onInput={(e) => setForm({ ...form, api_key: e.target.value })}
                  />
                </FormField>
                <FormField switchInside>
                  <Switch
                    checked={form.trust_public_url}
                    onChange={(v) => setForm({ ...form, trust_public_url: v })}
                    label="Trust public HTTPS URL"
                    description="Required for hosted providers that enforce HTTPS."
                  />
                </FormField>
                <FormField switchInside>
                  <Switch
                    checked={form.enabled}
                    onChange={(v) => setForm({ ...form, enabled: v })}
                    label="Show in model pickers"
                    description="Disable to hide all this provider's models without removing them."
                  />
                </FormField>
              </FormGrid>
              <div class="form-actions">
                <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
                <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={create} disabled={!form.name || !form.base_url}>
                  Create provider
                </Button>
              </div>
            </FormSection>
          </Card>
        )}

        {providers.length === 0 && !showNew && (
          <EmptyState
            icon={<Icon name="terminal" size={48} />}
            title="No providers yet"
            body="Add a provider to use local or hosted models."
            cta={<Button variant="primary" onClick={() => setShowNew(true)}>Add first provider</Button>}
          />
        )}

        {providers.map((provider) => {
          const s = status[provider.id] || {};
          return (
            <Card key={provider.id} title={provider.name}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--sp-3)", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                    {optionForProviderType(provider.provider_type).label} · {provider.base_url} · {provider.has_api_key ? "API key saved" : "no API key"}
                  </div>
                  <div style={{ marginTop: "var(--sp-1)" }}>
                    <StatusPill status={provider.enabled ? "enabled" : "disabled"} size="sm" />
                  </div>
                  {s.test && (
                    <div style={{ marginTop: "var(--sp-2)", color: s.test.ok ? "var(--status-done)" : "var(--status-error)", fontSize: "var(--text-sm)" }}>
                      {s.test.ok
                        ? `Reachable (${s.test.status}) in ${s.test.duration_ms ?? 0}ms`
                        : `Unreachable: ${s.test.error || `HTTP ${s.test.status}`}`}
                    </div>
                  )}
                  {s.discovery && (
                    <div style={{ marginTop: "var(--sp-2)", color: s.discovery.error ? "var(--status-error)" : "var(--status-done)", fontSize: "var(--text-sm)" }}>
                      {s.discovery.error ? `Discovery failed: ${s.discovery.error}` : `Discovered ${s.discovery.count} model${s.discovery.count === 1 ? "" : "s"}.`}
                    </div>
                  )}
                </div>
                <div class="toolbar">
                  <Button size="sm" variant="secondary" onClick={() => patch(provider, { enabled: !provider.enabled })}>
                    {provider.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" variant="secondary" iconLeft={<Icon name="check-circle" size={12} />} onClick={() => test(provider)} loading={s.testing}>
                    Test
                  </Button>
                  <Button size="sm" variant="secondary" iconLeft={<Icon name="refresh-cw" size={12} />} onClick={() => discover(provider)} loading={s.discovering}>
                    Discover
                  </Button>
                  <ConfirmButton class="sm" onConfirm={() => remove(provider)}>Delete</ConfirmButton>
                </div>
              </div>
              <div style={{ marginTop: "var(--sp-4)", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "var(--sp-2)" }}>
                {(models[provider.id] || []).map((model) => {
                  const caps = model.capabilities || {};
                  const runnable = caps.runnable_for_agent !== false;
                  return (
                    <div key={model.id} class="card card-inset" style={{ padding: "var(--sp-3)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-2)" }}>
                        <div style={{ minWidth: 0 }}>
                          <strong style={{ fontSize: "var(--text-sm)" }}>{model.display_name || model.model_name}</strong>
                          <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)" }}>{model.model_name}</div>
                          <div style={{ marginTop: "var(--sp-1)", display: "flex", flexWrap: "wrap", gap: "var(--sp-1)" }}>
                            <Capability on={runnable} label="chat" />
                            <Capability on={caps.tool_use} label="tools" />
                            <Capability on={caps.reasoning} label={caps.reasoning_mode === "toggle" ? "thinking" : "reasoning"} />
                            <Capability on={caps.vision} label="vision" />
                            <Capability on={caps.json_mode} label="json" />
                          </div>
                        </div>
                        <Switch
                          checked={!!model.enabled}
                          disabled={!model.enabled && !runnable}
                          onChange={() => api.patchProviderModel(provider.id, model.id, { enabled: !model.enabled }).then(load)}
                          label={!model.enabled && !runnable ? "Not runnable" : (model.enabled ? "Enabled" : "Disabled")}
                        />
                      </div>
                    </div>
                  );
                })}
                {(models[provider.id] || []).length === 0 && (
                  <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>No models discovered yet.</div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </AppShell>
  );
}
