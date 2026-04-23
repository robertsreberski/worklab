import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { AppShell } from "../components/AppShell.jsx";
import { SwitchField } from "../components/SwitchField.jsx";
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
    pushToast("Settings saved", { variant: "success", ttl: 2500 });
  });

  if (!settings) {
    return (
      <AppShell route="settings" title="Settings">
        <div class="page-wrap"><div style={{ color: "var(--muted)" }}>Loading...</div></div>
      </AppShell>
    );
  }

  const currentEmbedding = settings.default_embedding_model || "";
  const allEmbeddingValues = embeddingGroups.flatMap((g) => (g.models || []).map((m) => m.value));
  const embeddingOptions = [
    { label: "", options: [{ value: "", label: "(disabled — no embeddings)" }] },
    ...(currentEmbedding && !allEmbeddingValues.includes(currentEmbedding)
      ? [{ label: "Current", options: [{ value: currentEmbedding, label: `${currentEmbedding} (custom)` }] }]
      : []),
    ...embeddingGroups.map((g) => ({
      label: g.available === false ? `${g.label} (credentials not set)` : g.label,
      options: (g.models || []).map((m) => ({ value: m.value, label: m.label || m.value })),
    })),
  ];

  const headerActions = (
    <button
      class="button primary"
      onClick={() => formSave.save().catch(() => {})}
      disabled={formSave.saving}
    >
      {formSave.saving ? "Saving..." : "Save"}
    </button>
  );

  return (
    <AppShell route="settings" title="Settings" headerActions={headerActions}>
      <div class="page-wrap">
        {formSave.error && <div class="form-error">Save failed: {formSave.error}</div>}

        <div class="settings-sections">
          <section class="settings-section">
            <h3>Consolidation</h3>
            <p>Nightly memory consolidation refreshes agent journal summaries.</p>
            <div class="form-grid">
              <div class="field">
                <label class="field-label">Hour (0–23)</label>
                <input
                  class="form-input"
                  type="number"
                  min="0"
                  max="23"
                  value={settings.consolidation_hour}
                  onInput={(e) => setSettings({ ...settings, consolidation_hour: e.target.value })}
                />
              </div>
              <div class="field">
                <SwitchField
                  checked={settings.consolidation_enabled}
                  onChange={(e) => setSettings({ ...settings, consolidation_enabled: e.target.checked })}
                >
                  Enabled
                </SwitchField>
              </div>
              <div class="field">
                <label class="field-label">Journal tail lines</label>
                <input
                  class="form-input"
                  type="number"
                  min="0"
                  max="1000"
                  value={settings.journal_tail_lines}
                  onInput={(e) => setSettings({ ...settings, journal_tail_lines: e.target.value })}
                />
              </div>
              <div class="field">
                <label class="field-label">Pinned KB limit</label>
                <input
                  class="form-input"
                  type="number"
                  min="0"
                  max="100"
                  value={settings.kb_pinned_limit}
                  onInput={(e) => setSettings({ ...settings, kb_pinned_limit: e.target.value })}
                />
              </div>
            </div>
          </section>

          <section class="settings-section">
            <h3>Execution</h3>
            <p>Limits for worker subprocesses.</p>
            <div class="form-grid">
              <div class="field">
                <label class="field-label">Worker timeout (ms)</label>
                <input
                  class="form-input"
                  type="number"
                  value={settings.worker_timeout_ms}
                  onInput={(e) => setSettings({ ...settings, worker_timeout_ms: e.target.value })}
                />
              </div>
              <div class="field">
                <label class="field-label">Cancel grace (ms)</label>
                <input
                  class="form-input"
                  type="number"
                  value={settings.cancel_grace_ms}
                  onInput={(e) => setSettings({ ...settings, cancel_grace_ms: e.target.value })}
                />
              </div>
            </div>
          </section>

          <section class="settings-section">
            <h3>Search & embeddings</h3>
            <p>Controls which embedding model is used to index knowledge and journals.</p>
            <div class="field">
              <label class="field-label">Embedding model</label>
              <SelectField
                value={currentEmbedding}
                options={embeddingOptions}
                onChange={(value) => setSettings({ ...settings, default_embedding_model: value })}
              />
              <span class="field-hint">Disabled skips vectorization. Run "Discover" on a provider to surface more models.</span>
            </div>
            {indexStatus && (
              <div style={{ fontSize: 12, color: indexStatus.errors ? "var(--yellow)" : "var(--muted)" }}>
                Search index: {indexStatus.total} chunks · {indexStatus.vectorized} vectorized · {indexStatus.errors} errors · {indexStatus.model || "—"}
                {indexStatus.model && !indexStatus.ready && ` · paused (${indexStatus.reason || "provider not configured"})`}
              </div>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
