import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { SelectField } from "../components/SelectField.jsx";
import { SwitchField } from "../components/SwitchField.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { AdvancedMeta } from "../components/AdvancedMeta.jsx";
import { humanizeSlug, skillDisplayName } from "../lib/display.js";

const emptySkill = { name: "", meta: { display_name: "", trigger: "", enabled: true, priority: "" }, body: "" };

export function SkillEdit({ name, onSaved, onDeleted }) {
  const isNew = name === "new";
  const [skill, setSkill] = useState(isNew ? emptySkill : null);
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    if (!isNew) {
      api.getSkill(name).then(r => setSkill(r.skill)).catch(() => setSkill({ notFound: true }));
      api.skillUsage(name).then(setUsage).catch(() => {});
    } else {
      setSkill(emptySkill);
      setUsage(null);
    }
  }, [name, isNew]);

  const formSave = useFormSave(async () => {
    const payload = {
      meta: { ...skill.meta, trigger: skill.meta.trigger, enabled: !!skill.meta.enabled },
      body: skill.body,
    };
    if (!skill.meta.priority) delete payload.meta.priority;
    if (isNew) {
      const res = await api.createSkill({ ...payload });
      onSaved?.(res.skill.name);
    } else {
      await api.patchSkill(name, payload);
      onSaved?.(name);
    }
  });

  if (!skill) return <div class="pane-empty">Loading skill...</div>;
  if (skill.notFound) return (
    <div class="pane-empty">
      <h3>Skill not found</h3>
      <p>This skill may have been deleted.</p>
    </div>
  );

  async function destroy() {
    try {
      await api.deleteSkill(name);
      onDeleted?.();
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  const title = isNew ? "New skill" : skillDisplayName(skill);

  return (
    <>
      <header class="pane-detail-head">
        <div style={{ minWidth: 0 }}>
          <div class="eyebrow">{isNew ? "Create skill" : "Skill"}</div>
          <h2>{title}</h2>
        </div>
        <div class="toolbar">
          <StatusPill status={skill.meta.enabled !== false ? "enabled" : "disabled"} />
          {!isNew && <ConfirmButton class="button danger" onConfirm={destroy} confirmLabel="Click again to delete">Delete</ConfirmButton>}
          <button
            class="button primary"
            onClick={() => formSave.save().catch(() => {})}
            disabled={formSave.saving || !(skill.meta.display_name || skill.name)}
          >
            {formSave.saving ? "Saving..." : (isNew ? "Create" : "Save")}
          </button>
        </div>
      </header>
      <div class="pane-detail-body">
        {formSave.error && <div class="form-error">Save failed: {formSave.error}</div>}

        <section class="surface-panel">
          <div class="section-kicker">Metadata</div>
          <h3>Activation</h3>
          <div class="form-grid">
            <div class="field span-2">
              <label class="field-label">Display name</label>
              <input
                class="form-input"
                value={skill.meta.display_name || (isNew ? "" : humanizeSlug(skill.name))}
                onInput={(e) => setSkill({ ...skill, meta: { ...skill.meta, display_name: e.target.value } })}
              />
            </div>
            <div class="field">
              <label class="field-label">Priority</label>
              <SelectField
                value={skill.meta.priority || ""}
                options={[
                  { value: "", label: "On demand" },
                  { value: "always", label: "Always inline full body" },
                ]}
                onChange={(v) => setSkill({ ...skill, meta: { ...skill.meta, priority: v || undefined } })}
              />
            </div>
            <div class="field">
              <SwitchField
                checked={skill.meta.enabled !== false}
                onChange={(e) => setSkill({ ...skill, meta: { ...skill.meta, enabled: e.target.checked } })}
                description="Unavailable skills stay saved but are not offered to agents."
              >
                Available to agents
              </SwitchField>
            </div>
            <div class="field span-2">
              <label class="field-label">Trigger</label>
              <input
                class="form-input"
                placeholder="When should this skill activate?"
                value={skill.meta.trigger || ""}
                onInput={(e) => setSkill({ ...skill, meta: { ...skill.meta, trigger: e.target.value } })}
              />
            </div>
          </div>
          <AdvancedMeta items={[{ label: "Slug", value: isNew ? "Generated after create" : skill.name }]} />
        </section>

        <section class="surface-panel">
          <div class="section-kicker">Playbook</div>
          <h3>Body (Markdown)</h3>
          <div class="field">
            <textarea
              class="form-input mono-input"
              rows="22"
              value={skill.body}
              onInput={(e) => setSkill({ ...skill, body: e.target.value })}
            />
          </div>
        </section>

        {!isNew && usage && usage.explicit?.length > 0 && (
          <section class="surface-panel">
            <div class="section-kicker">References</div>
            <h3>Used by agents</h3>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {usage.explicit.map((a) => (
                <li key={a.name}>
                  <a href={`#/agents/${a.name}`}>{a.display_name || a.name}</a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
