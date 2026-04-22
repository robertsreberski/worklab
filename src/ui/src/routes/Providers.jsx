import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

const emptyForm = {
  name: "",
  provider_type: "ollama",
  base_url: "http://localhost:11434",
  api_key: "",
  trust_public_url: false,
  enabled: true,
};

export function Providers() {
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState({});
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState(null);

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
        <div class="field"><label>Name</label>
          <input value={form.name} onInput={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div class="field"><label>Type</label>
          <select value={form.provider_type} onChange={(e) => setForm({
            ...form,
            provider_type: e.target.value,
            base_url: e.target.value === "ollama" ? "http://localhost:11434" : form.base_url,
          })}>
            <option value="ollama">ollama</option>
            <option value="openai_compat">openai_compat</option>
          </select></div>
        <div class="field"><label>Base URL</label>
          <input value={form.base_url} onInput={(e) => setForm({ ...form, base_url: e.target.value })} /></div>
        <div class="field"><label>API key (write-only)</label>
          <input type="password" value={form.api_key} onInput={(e) => setForm({ ...form, api_key: e.target.value })} /></div>
        <label style="display:block;margin-bottom:8px">
          <input type="checkbox" checked={form.trust_public_url} onChange={(e) => setForm({ ...form, trust_public_url: e.target.checked })} />
          Trust public HTTPS URL
        </label>
        <button class="primary" disabled={!form.name || !form.base_url} onClick={create}>Create provider</button>
      </section>

      <div class="provider-list">
        {providers.map((provider) => (
          <section class="provider-card" key={provider.id}>
            <div class="provider-head">
              <div>
                <h3>{provider.name}</h3>
                <div class="meta">{provider.provider_type} · {provider.base_url} · {provider.has_api_key ? "API key saved" : "no API key"}</div>
              </div>
              <div>
                <button onClick={() => patch(provider, { enabled: !provider.enabled })}>{provider.enabled ? "Disable" : "Enable"}</button>
                <button onClick={() => discover(provider)} style="margin-left:8px">Discover</button>
                <button onClick={() => remove(provider)} style="margin-left:8px;color:#ff7a7a">Delete</button>
              </div>
            </div>
            <div class="provider-models">
              {(models[provider.id] || []).map((model) => (
                <div class="provider-model" key={model.id}>
                  <div>
                    <strong>{model.display_name || model.model_name}</strong>
                    <div class="meta">{model.model_name}</div>
                  </div>
                  <button onClick={() => api.patchProviderModel(provider.id, model.id, { enabled: !model.enabled }).then(load)}>
                    {model.enabled ? "Disable" : "Enable"}
                  </button>
                </div>
              ))}
              {(models[provider.id] || []).length === 0 && <div class="meta">No models discovered yet.</div>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
