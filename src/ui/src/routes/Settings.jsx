import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { CheckboxField } from "../components/CheckboxField.jsx";
import { SelectField } from "../components/SelectField.jsx";

export function Settings() {
  const [settings, setSettings] = useState(null);
  const [indexStatus, setIndexStatus] = useState(null);
  const [embeddingGroups, setEmbeddingGroups] = useState([]);

  useEffect(() => {
    api.getSettings().then((r) => setSettings(r.settings));
    api.searchStatus().then((r) => setIndexStatus(r.status)).catch(() => setIndexStatus(null));
    api.listEmbeddingModels().then((r) => setEmbeddingGroups(r.groups || [])).catch(() => setEmbeddingGroups([]));
  }, []);

  const formSave = useFormSave(async () => {
    await api.patchSettings({
      consolidation_hour: Number(settings.consolidation_hour),
      consolidation_enabled: !!settings.consolidation_enabled,
      worker_timeout_ms: Number(settings.worker_timeout_ms),
      cancel_grace_ms: Number(settings.cancel_grace_ms),
      journal_tail_lines: Number(settings.journal_tail_lines),
      kb_pinned_limit: Number(settings.kb_pinned_limit),
      default_embedding_model: settings.default_embedding_model,
    });
    pushToast("Settings saved.", { variant: "success", ttl: 2500 });
  });

  if (!settings) return <div>Loading...</div>;

  const currentEmbedding = settings.default_embedding_model || "";
  const allEmbeddingValues = embeddingGroups.flatMap((group) => (group.models || []).map((model) => model.value));
  const embeddingOptions = [
    { label: "", options: [{ value: "", label: "(disabled — no embeddings)" }] },
    ...(currentEmbedding && !allEmbeddingValues.includes(currentEmbedding)
      ? [{ label: "Current", options: [{ value: currentEmbedding, label: `${currentEmbedding} (custom)` }] }]
      : []),
    ...embeddingGroups.map((group) => ({
      label: group.available === false ? `${group.label} (credentials not set)` : group.label,
      options: (group.models || []).map((model) => ({
        value: model.value,
        label: model.label || model.value,
        description: model.description,
      })),
    })),
  ];
  const selectedEmbeddingGroup = embeddingGroups.find((group) =>
    (group.models || []).some((model) => model.value === currentEmbedding)
  ) || null;
  const embeddingGroupUnavailable = !!selectedEmbeddingGroup && selectedEmbeddingGroup.available === false;

  return (
    <div class="detail page-stack">
      <div class="page-header">
        <div>
          <div class="eyebrow">Runtime</div>
          <h2 class="page-title">Settings</h2>
        </div>
        <button class="primary" onClick={() => formSave.save().catch(() => {})} disabled={formSave.saving}>
          {formSave.saving ? "Saving..." : "Save"}
        </button>
      </div>
      {formSave.error && <div class="form-error" role="alert">Save failed: {formSave.error}</div>}

      <section class="surface-panel">
        <div class="section-kicker">Automation</div>
        <h3 class="section-title">Consolidation</h3>
        <div class="settings-grid">
          <div class="field"><label>Consolidation hour (0-23)</label>
            <input type="number" min="0" max="23" value={settings.consolidation_hour}
              onInput={(e) => setSettings({ ...settings, consolidation_hour: e.target.value })} /></div>
          <div class="field">
            <CheckboxField
              checked={settings.consolidation_enabled}
              onChange={(e) => setSettings({ ...settings, consolidation_enabled: e.target.checked })}
            >
              Consolidation enabled
            </CheckboxField>
          </div>
          <div class="field"><label>Journal tail lines</label>
            <input type="number" min="0" max="1000" value={settings.journal_tail_lines}
              onInput={(e) => setSettings({ ...settings, journal_tail_lines: e.target.value })} /></div>
          <div class="field"><label>Pinned KB limit</label>
            <input type="number" min="0" max="100" value={settings.kb_pinned_limit}
              onInput={(e) => setSettings({ ...settings, kb_pinned_limit: e.target.value })} /></div>
        </div>
      </section>

      <section class="surface-panel">
        <div class="section-kicker">Workers</div>
        <h3 class="section-title">Execution limits</h3>
        <div class="settings-grid">
          <div class="field"><label>Worker timeout (ms)</label>
            <input type="number" value={settings.worker_timeout_ms}
              onInput={(e) => setSettings({ ...settings, worker_timeout_ms: e.target.value })} /></div>
          <div class="field"><label>Cancel grace (ms)</label>
            <input type="number" value={settings.cancel_grace_ms}
              onInput={(e) => setSettings({ ...settings, cancel_grace_ms: e.target.value })} /></div>
        </div>
      </section>

      <section class="surface-panel">
        <div class="section-kicker">Search</div>
        <h3 class="section-title">Indexing</h3>
        <div class="field">
          <label>Embedding model</label>
          <SelectField
            value={currentEmbedding}
            options={embeddingOptions}
            onChange={(value) => setSettings({ ...settings, default_embedding_model: value })}
            placeholder="(disabled — no embeddings)"
          />
          <div class="meta">Disabled skips vectorization. Enabled custom providers contribute embedding-tagged models automatically; run Discover on a provider if none appear.</div>
          {embeddingGroupUnavailable && (
            <div class="status-line warn">
              {selectedEmbeddingGroup.unavailable_reason || "Provider credentials not configured — vectorization is paused."}
            </div>
          )}
        </div>
        {indexStatus && (
          <div class={indexStatus.errors ? "status-line warn" : indexStatus.model && !indexStatus.ready ? "status-line muted" : "status-line ok"}>
            Search index: {indexStatus.total} chunks / {indexStatus.vectorized} vectorized / {indexStatus.errors} errors / {indexStatus.model || "—"}
            {indexStatus.model && !indexStatus.ready && ` / paused — ${indexStatus.reason || "provider not configured"}`}
          </div>
        )}
      </section>
    </div>
  );
}
