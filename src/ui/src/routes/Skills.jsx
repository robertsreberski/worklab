// src/ui/src/routes/Skills.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";

export function Skills() {
  const [skills, setSkills] = useState([]);
  const reload = useCallback(() => { api.listSkills().then(r => setSkills(r.skills)); }, []);
  useEffect(() => { reload(); }, [reload]);

  return (
    <div class="detail">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="margin:0">Skills</h2>
        <a href="#/skills/new" class="primary" style="padding:6px 10px;border-radius:4px;background:var(--accent);color:#fff;text-decoration:none">+ New skill</a>
      </div>
      {skills.length === 0 && <div class="meta">No skills yet.</div>}
      <ul style="list-style:none;padding:0">
        {skills.map(s => (
          <li key={s.name} class="task-card" style="margin-bottom:8px">
            <a href={`#/skills/${s.name}`} style="color:inherit;text-decoration:none">
              <h4>{s.name} {s.priority === "always" && <span class="meta">(always-inlined)</span>}</h4>
              <div class="meta">{s.trigger} · {s.enabled ? "enabled" : "disabled"}</div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
