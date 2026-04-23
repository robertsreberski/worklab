// src/ui/src/routes/Skills.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { Icon } from "../components/Icon.jsx";
import { StatusSignal } from "../components/StatusSignal.jsx";
import { skillDisplayName } from "../lib/display.js";

export function Skills() {
  const [skills, setSkills] = useState([]);
  const reload = useCallback(() => { api.listSkills().then(r => setSkills(r.skills)); }, []);
  useEffect(() => { reload(); }, [reload]);

  return (
    <div class="detail page-stack">
      <div class="page-header">
        <div>
          <div class="eyebrow">Playbooks</div>
          <h2 class="page-title">Skills</h2>
          <div class="page-copy">{skills.length} available</div>
        </div>
        <a href="#/skills/new" class="primary"><Icon name="plus" size={15} />New skill</a>
      </div>
      {skills.length === 0 && <div class="meta">No skills yet.</div>}
      <div class="entity-list">
        {skills.map(s => (
          <a key={s.name} href={`#/skills/${s.name}`} class="entity-row">
            <div class="entity-avatar entity-avatar-skill" aria-hidden="true"><Icon name="sparkles" size={16} /></div>
            <div class="entity-row-main">
              <h4>{skillDisplayName(s)}</h4>
              <div class="entity-row-subtitle">{s.trigger || "No trigger defined."}</div>
              <div class="entity-row-meta">
                <span>{s.priority === "always" ? "Always in context" : "On demand"}</span>
              </div>
            </div>
            <StatusSignal tone={s.enabled ? "green" : "muted"}>{s.enabled ? "Available" : "Unavailable"}</StatusSignal>
          </a>
        ))}
      </div>
    </div>
  );
}
