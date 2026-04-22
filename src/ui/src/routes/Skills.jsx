// src/ui/src/routes/Skills.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";

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
        <a href="#/skills/new" class="primary">New skill</a>
      </div>
      {skills.length === 0 && <div class="meta">No skills yet.</div>}
      <div class="list-stack">
        {skills.map(s => (
          <a key={s.name} href={`#/skills/${s.name}`} class="list-row">
            <div class="list-row-main">
              <h4>{s.name} {s.priority === "always" && <span class="meta">(always-inlined)</span>}</h4>
              <div class="meta">{s.trigger || "No trigger"}</div>
            </div>
            <span class={s.enabled ? "status-badge done" : "status-badge muted"}>{s.enabled ? "Enabled" : "Disabled"}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
