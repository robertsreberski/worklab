import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

export function Settings() {
  const [settings, setSettings] = useState(null);
  const [indexStatus, setIndexStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSettings().then((r) => setSettings(r.settings));
    api.searchStatus().then((r) => setIndexStatus(r.status)).catch(() => setIndexStatus(null));
  }, []);

  if (!settings) return <div>Loading…</div>;

  async function save() {
    setSaving(true);
    try {
      await api.patchSettings({
        consolidation_hour: Number(settings.consolidation_hour),
        consolidation_enabled: !!settings.consolidation_enabled,
        worker_timeout_ms: Number(settings.worker_timeout_ms),
        cancel_grace_ms: Number(settings.cancel_grace_ms),
        journal_tail_lines: Number(settings.journal_tail_lines),
        kb_pinned_limit: Number(settings.kb_pinned_limit),
        default_embedding_model: settings.default_embedding_model,
      });
    } finally { setSaving(false); }
  }

  return (
    <div class="detail">
      <h2>Settings</h2>
      <div class="field"><label>Consolidation hour (0-23)</label>
        <input type="number" min="0" max="23" value={settings.consolidation_hour}
          onInput={(e) => setSettings({ ...settings, consolidation_hour: e.target.value })} /></div>
      <div class="field">
        <label class="choice-label">
          <input type="checkbox" checked={settings.consolidation_enabled}
            onChange={(e) => setSettings({ ...settings, consolidation_enabled: e.target.checked })} />
          <span>Consolidation enabled</span>
        </label>
      </div>
      <div class="field"><label>Worker timeout (ms)</label>
        <input type="number" value={settings.worker_timeout_ms}
          onInput={(e) => setSettings({ ...settings, worker_timeout_ms: e.target.value })} /></div>
      <div class="field"><label>Cancel grace (ms)</label>
        <input type="number" value={settings.cancel_grace_ms}
          onInput={(e) => setSettings({ ...settings, cancel_grace_ms: e.target.value })} /></div>
      <div class="field"><label>Journal tail lines</label>
        <input type="number" min="0" max="1000" value={settings.journal_tail_lines}
          onInput={(e) => setSettings({ ...settings, journal_tail_lines: e.target.value })} /></div>
      <div class="field"><label>Pinned KB limit</label>
        <input type="number" min="0" max="100" value={settings.kb_pinned_limit}
          onInput={(e) => setSettings({ ...settings, kb_pinned_limit: e.target.value })} /></div>
      <div class="field"><label>Embedding model</label>
        <input value={settings.default_embedding_model || ""}
          onInput={(e) => setSettings({ ...settings, default_embedding_model: e.target.value })} />
        <div class="meta">Use ollama:&lt;model&gt;, openai:&lt;model&gt;, or vercel:&lt;providerId&gt;:&lt;model&gt;.</div>
      </div>
      {indexStatus && (
        <div class="meta" style="margin:12px 0">
          Search index: {indexStatus.total} chunks · {indexStatus.vectorized} vectorized · {indexStatus.errors} errors · {indexStatus.model}
        </div>
      )}
      <button class="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    </div>
  );
}
