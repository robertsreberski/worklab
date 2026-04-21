import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

export function Settings() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSettings().then((r) => setSettings(r.settings));
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
      });
    } finally { setSaving(false); }
  }

  return (
    <div class="detail">
      <h2>Settings</h2>
      <div class="field"><label>Consolidation hour (0-23)</label>
        <input type="number" min="0" max="23" value={settings.consolidation_hour}
          onInput={(e) => setSettings({ ...settings, consolidation_hour: e.target.value })} /></div>
      <div class="field"><label>Consolidation enabled</label>
        <input type="checkbox" checked={settings.consolidation_enabled}
          onChange={(e) => setSettings({ ...settings, consolidation_enabled: e.target.checked })} /></div>
      <div class="field"><label>Worker timeout (ms)</label>
        <input type="number" value={settings.worker_timeout_ms}
          onInput={(e) => setSettings({ ...settings, worker_timeout_ms: e.target.value })} /></div>
      <div class="field"><label>Cancel grace (ms)</label>
        <input type="number" value={settings.cancel_grace_ms}
          onInput={(e) => setSettings({ ...settings, cancel_grace_ms: e.target.value })} /></div>
      <button class="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    </div>
  );
}
