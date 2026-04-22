import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

const PROVIDER_TYPE_OPTIONS = [
  { value: "ollama", label: "Ollama", helper: "Local / LAN", description: "Native Ollama server for local or private-network models." },
  { value: "lmstudio", label: "LM Studio", helper: "Local / LAN", description: "LM Studio running as an OpenAI-compatible local server." },
  { value: "vllm", label: "vLLM", helper: "Self-hosted", description: "Dedicated self-hosted OpenAI-compatible serving." },
  { value: "openai_compat", label: "OpenAI-compatible", helper: "Custom gateway", description: "Generic `/v1/chat/completions` compatible endpoint." },
  { value: "anthropic_compat", label: "Anthropic-compatible", helper: "Custom gateway", description: "Anthropic-style compatible API surface." },
  { value: "google_compat", label: "Google-compatible", helper: "Custom gateway", description: "Google-style compatible model endpoint." },
  { value: "groq", label: "Groq", helper: "Hosted", description: "Hosted inference for supported open models." },
  { value: "openrouter", label: "OpenRouter", helper: "Hosted", description: "Multi-provider routing with a single endpoint." },
  { value: "together", label: "Together AI", helper: "Hosted", description: "Hosted open models with broad catalogue coverage." },
  { value: "fireworks", label: "Fireworks AI", helper: "Hosted", description: "Hosted open-model inference endpoints." },
  { value: "deepseek", label: "DeepSeek", helper: "Hosted", description: "DeepSeek-hosted compatible API endpoints." },
];

const PRESETS = {
  ollama: { name: "Ollama (local)", base_url: "http://localhost:11434", trust_public_url: false, api_key_hint: "No API key is needed for most local Ollama setups." },
  lmstudio: { name: "LM Studio", base_url: "http://localhost:1234", trust_public_url: false, api_key_hint: "Usually no API key unless you configured one locally." },
  vllm: { name: "vLLM", base_url: "http://localhost:8000", trust_public_url: false, api_key_hint: "Often fronted by an internal gateway or reverse proxy." },
  openai_compat: { name: "Custom gateway", base_url: "", trust_public_url: false, api_key_hint: "Use this for any generic OpenAI-compatible host." },
  anthropic_compat: { name: "Anthropic-compatible", base_url: "", trust_public_url: false, api_key_hint: "Use this when a provider mirrors Anthropic semantics." },
  google_compat: { name: "Google-compatible", base_url: "", trust_public_url: false, api_key_hint: "Use this when a provider mirrors Google-style APIs." },
  groq: { name: "Groq", base_url: "https://api.groq.com/openai", trust_public_url: true, api_key_hint: "Groq requires a stored API key." },
  openrouter: { name: "OpenRouter", base_url: "https://openrouter.ai/api", trust_public_url: true, api_key_hint: "OpenRouter requires a stored API key." },
  together: { name: "Together AI", base_url: "https://api.together.xyz", trust_public_url: true, api_key_hint: "Together requires a stored API key." },
  fireworks: { name: "Fireworks AI", base_url: "https://api.fireworks.ai/inference", trust_public_url: true, api_key_hint: "Fireworks requires a stored API key." },
  deepseek: { name: "DeepSeek", base_url: "https://api.deepseek.com", trust_public_url: true, api_key_hint: "DeepSeek requires a stored API key." },
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
  return PROVIDER_TYPE_OPTIONS.find((option) => option.value === value) || PROVIDER_TYPE_OPTIONS[0];
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

function CapabilityBadge({ on, label, title }) {
  return (
    <span
      class="meta"
      title={title}
      style={`display:inline-block;margin-right:6px;padding:2px 6px;border-radius:999px;border:1px solid ${on ? "var(--accent)" : "var(--border)"};opacity:${on ? 1 : 0.55}`}
    >
      {label}
    </span>
  );
}

export function Providers() {
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState({});
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState(null);
  const selectedType = optionForProviderType(form.provider_type);
  const preset = PRESETS[form.provider_type] || PRESETS.openai_compat;

  async function load() {
    const res = await api.listProviders();
    setProviders(res.providers || []);
    const modelPairs = await Promise.all((res.providers || []).map(async (provider) => {
      try {
        const m = await api.listProviderModels(provider.id);
        return [provider.id, m.models || []];
      } catch {
        return [provider.id, []];
      }
    }));
    setModels(Object.fromEntries(modelPairs));
  }

  useEffect(() => { load(); }, []);

  async function create() {
    setError(null);
    try {
      await api.createProvider({ ...form, api_key: form.api_key || undefined });
      setForm(emptyForm);
      await load();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function patch(provider, patch) {
    await api.patchProvider(provider.id, patch);
    await load();
  }

  async function test(provider) {
    const result = await api.testProvider(provider.id);
    setError(result.ok ? null : `${provider.name}: ${result.error || `HTTP ${result.status}`}`);
  }

  async function discover(provider) {
    await api.discoverProviderModels(provider.id);
    await load();
  }

  async function remove(provider) {
    if (!confirm(`Delete provider "${provider.name}"?`)) return;
    await api.deleteProvider(provider.id);
    await load();
  }

  return (
    <div class="detail">
      <h2>Providers</h2>
      {error && <div style="color:#ff7a7a;margin-bottom:12px">{error}</div>}

      <section class="panel-section">
        <h3>New provider</h3>
        <div class="meta" style="margin-bottom:12px">{selectedType.description}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-bottom:12px">
          {PROVIDER_TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setForm((current) => applyPreset(current, option.value))}
              style={`text-align:left;padding:10px;border-radius:6px;border:1px solid ${form.provider_type === option.value ? "var(--accent)" : "var(--border)"};background:var(--panel)`}
            >
              <div><strong>{option.label}</strong></div>
              <div class="meta">{option.helper}</div>
            </button>
          ))}
        </div>

        <div class="field"><label>Name</label>
          <input value={form.name} onInput={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div class="field"><label>Type</label>
          <select value={form.provider_type} onChange={(e) => setForm((current) => applyPreset(current, e.target.value))}>
            {PROVIDER_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></div>
        <div class="field"><label>Base URL</label>
          <input value={form.base_url} placeholder={preset.base_url || "https://example.com"} onInput={(e) => setForm({ ...form, base_url: e.target.value })} /></div>
        <div class="field"><label>API key (write-only)</label>
          <input type="password" value={form.api_key} onInput={(e) => setForm({ ...form, api_key: e.target.value })} />
          <div class="meta">{preset.api_key_hint}</div>
        </div>
        <label style="display:block;margin-bottom:8px">
          <input type="checkbox" checked={form.trust_public_url} onChange={(e) => setForm({ ...form, trust_public_url: e.target.checked })} />
          Trust public HTTPS URL
        </label>
        <label style="display:block;margin-bottom:12px">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Show this provider in model pickers
        </label>
        <button class="primary" disabled={!form.name || !form.base_url} onClick={create}>Create provider</button>
      </section>

      <div class="provider-list">
        {providers.map((provider) => (
          <section class="provider-card" key={provider.id}>
            <div class="provider-head">
              <div>
                <h3>{provider.name}</h3>
                <div class="meta">{optionForProviderType(provider.provider_type).label} · {provider.base_url} · {provider.has_api_key ? "API key saved" : "no API key"}</div>
              </div>
              <div>
                <button onClick={() => patch(provider, { enabled: !provider.enabled })}>{provider.enabled ? "Disable" : "Enable"}</button>
                <button onClick={() => test(provider)} style="margin-left:8px">Test</button>
                <button onClick={() => discover(provider)} style="margin-left:8px">Discover</button>
                <button onClick={() => remove(provider)} style="margin-left:8px;color:#ff7a7a">Delete</button>
              </div>
            </div>
            <div class="provider-models">
              {(models[provider.id] || []).map((model) => {
                const capabilities = model.capabilities || {};
                return (
                  <div class="provider-model" key={model.id}>
                    <div>
                      <strong>{model.display_name || model.model_name}</strong>
                      <div class="meta">{model.model_name}</div>
                      <div style="margin-top:6px">
                        <CapabilityBadge on={capabilities.tool_use} label="tools" title="Tool / function calling" />
                        <CapabilityBadge on={capabilities.reasoning} label={capabilities.reasoning_mode === "toggle" ? "thinking" : "reasoning"} title="Reasoning / thinking control" />
                        <CapabilityBadge on={capabilities.vision} label="vision" title="Vision / multimodal input" />
                        <CapabilityBadge on={capabilities.json_mode} label="json" title="Structured JSON output" />
                      </div>
                    </div>
                    <button onClick={() => api.patchProviderModel(provider.id, model.id, { enabled: !model.enabled }).then(load)}>
                      {model.enabled ? "Disable" : "Enable"}
                    </button>
                  </div>
                );
              })}
              {(models[provider.id] || []).length === 0 && <div class="meta">No models discovered yet.</div>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
