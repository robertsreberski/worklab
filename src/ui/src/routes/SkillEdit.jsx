// src/ui/src/routes/SkillEdit.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { ConfirmButton } from "../components/ConfirmButton.jsx";

const emptySkill = { name: "", meta: { trigger: "", enabled: true, priority: "" }, body: "" };

export function SkillEdit({ name }) {
  const isNew = name === "new";
  const [skill, setSkill] = useState(isNew ? emptySkill : null);
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    if (!isNew) {
      api.getSkill(name).then(r => setSkill(r.skill)).catch(() => setSkill({ notFound: true }));
      api.skillUsage(name).then(setUsage).catch(() => {});
    }
  }, [name, isNew]);

  const formSave = useFormSave(async () => {
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
  });

  if (!skill) return <div>Loading...</div>;
  if (skill.notFound) return <div>Skill not found. <a href="#/skills">Back</a></div>;

  async function destroy() {
    try {
      await api.deleteSkill(name);
      window.location.hash = "#/skills";
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  return (
    <div class="detail page-stack">
      <a href="#/skills" class="back-link">Back to skills</a>
      <section class="surface-panel task-hero">
        <div>
          <div class="eyebrow">Skill</div>
          <h2>{isNew ? "New skill" : skill.name}</h2>
          <div class="task-meta-grid">
            <span class={skill.meta.enabled !== false ? "status-badge done" : "status-badge muted"}>{skill.meta.enabled !== false ? "Enabled" : "Disabled"}</span>
            <span class="meta-pill">{skill.meta.priority === "always" ? "Always inlined" : "On demand"}</span>
          </div>
        </div>
        <div class="toolbar">
          <button class="primary" onClick={() => formSave.save().catch(() => {})} disabled={formSave.saving || !skill.name}>
            {formSave.saving ? "Saving..." : (isNew ? "Create" : "Save")}
          </button>
          {!isNew && <ConfirmButton class="danger" onConfirm={destroy} confirmLabel="Click again to delete">Delete</ConfirmButton>}
        </div>
      </section>
      {formSave.error && <div class="form-error" role="alert">Save failed: {formSave.error}</div>}

      <section class="surface-panel">
        <div class="section-kicker">Metadata</div>
        <h3 class="section-title">Activation</h3>
        <div class="form-grid">
          <div class="field">
            <label>Name (slug)</label>
            <input value={skill.name} disabled={!isNew}
              onInput={(e) => setSkill({ ...skill, name: e.target.value })} />
          </div>
          <div class="field">
            <label>Priority</label>
            <select value={skill.meta.priority || ""}
              onChange={(e) => setSkill({ ...skill, meta: { ...skill.meta, priority: e.target.value || undefined } })}>
              <option value="">On demand</option>
              <option value="always">Always inline full body</option>
            </select>
          </div>
          <div class="field span-2">
            <label>Trigger</label>
            <input value={skill.meta.trigger || ""}
              onInput={(e) => setSkill({ ...skill, meta: { ...skill.meta, trigger: e.target.value } })} />
          </div>
          <div class="field span-2">
            <label class="choice-label">
              <input type="checkbox" checked={skill.meta.enabled !== false}
                onChange={(e) => setSkill({ ...skill, meta: { ...skill.meta, enabled: e.target.checked } })} />
              <span>Enabled</span>
            </label>
          </div>
        </div>
      </section>

      <section class="surface-panel">
        <div class="section-kicker">Playbook</div>
        <h3 class="section-title">Body</h3>
        <div class="field">
          <label>Markdown</label>
          <textarea rows="22" value={skill.body}
            onInput={(e) => setSkill({ ...skill, body: e.target.value })}
            class="mono-input" />
        </div>
      </section>

      {!isNew && usage && (
        <section class="surface-panel">
          <div class="section-kicker">References</div>
          <h3 class="section-title">Used by agents</h3>
          {usage.explicit.length > 0 ? (
            <ul class="usage-list">
              {usage.explicit.map((agent) => (
                <li key={agent.name}>
                  <a href={`#/agents/${agent.name}`}>{agent.display_name || agent.name}</a>
                  <span class="meta">allowlisted</span>
                </li>
              ))}
            </ul>
          ) : (
            <div class="meta">No agent explicitly allowlists this skill.</div>
          )}
          {usage.openAllowlist > 0 && (
            <div class="meta">
              {usage.openAllowlist} agent{usage.openAllowlist === 1 ? "" : "s"} with an empty allowlist also
              {" "}can use this skill (they inherit all enabled skills).
            </div>
          )}
        </section>
      )}
    </div>
  );
}
