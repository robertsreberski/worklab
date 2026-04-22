// src/ui/src/routes/SkillEdit.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

const emptySkill = { name: "", meta: { trigger: "", enabled: true, priority: "" }, body: "" };

export function SkillEdit({ name }) {
  const isNew = name === "new";
  const [skill, setSkill] = useState(isNew ? emptySkill : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isNew) api.getSkill(name).then(r => setSkill(r.skill)).catch(() => setSkill({ notFound: true }));
  }, [name, isNew]);

  if (!skill) return <div>Loading…</div>;
  if (skill.notFound) return <div>Skill not found. <a href="#/skills">Back</a></div>;

  async function save() {
    setSaving(true); setError(null);
    try {
      const payload = {
        meta: { ...skill.meta, trigger: skill.meta.trigger, enabled: !!skill.meta.enabled },
        body: skill.body,
      };
      if (!skill.meta.priority) delete payload.meta.priority;
      if (isNew) {
        await api.createSkill({ name: skill.name, ...payload });
        window.location.hash = `#/skills/${skill.name}`;
      } else {
        await api.patchSkill(name, payload);
      }
    } catch (err) { setError(err.message || String(err)); }
    finally { setSaving(false); }
  }

  async function destroy() {
    if (!confirm(`Delete skill "${name}"?`)) return;
    await api.deleteSkill(name);
    window.location.hash = "#/skills";
  }

  return (
    <div class="detail">
      <a href="#/skills">← Back</a>
      <h2>{isNew ? "New skill" : skill.name}</h2>
      {error && <div style="color:#ff7a7a;margin-bottom:12px">{error}</div>}

      <div class="field"><label>Name (slug)</label>
        <input value={skill.name} disabled={!isNew}
          onInput={(e) => setSkill({ ...skill, name: e.target.value })} /></div>

      <div class="field"><label>Trigger</label>
        <input value={skill.meta.trigger || ""}
          onInput={(e) => setSkill({ ...skill, meta: { ...skill.meta, trigger: e.target.value } })} /></div>

      <div class="field"><label>Priority</label>
        <select value={skill.meta.priority || ""}
          onChange={(e) => setSkill({ ...skill, meta: { ...skill.meta, priority: e.target.value || undefined } })}>
          <option value="">(on demand)</option>
          <option value="always">always (inline full body in every system prompt)</option>
        </select></div>

      <div class="field"><label>Enabled</label>
        <input type="checkbox" checked={skill.meta.enabled !== false}
          onChange={(e) => setSkill({ ...skill, meta: { ...skill.meta, enabled: e.target.checked } })} /></div>

      <div class="field"><label>Body (markdown playbook)</label>
        <textarea rows="20" value={skill.body}
          onInput={(e) => setSkill({ ...skill, body: e.target.value })}
          style="font-family:ui-monospace,Menlo,Monaco,monospace" /></div>

      <button class="primary" onClick={save} disabled={saving || !skill.name}>
        {saving ? "Saving…" : (isNew ? "Create" : "Save")}
      </button>
      {!isNew && <button onClick={destroy} style="margin-left:8px;color:#ff7a7a">Delete</button>}
    </div>
  );
}
