// src/ui/src/routes/Agents.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";

export function Agents() {
  const [agents, setAgents] = useState([]);
  const reload = useCallback(() => { api.listAgents().then(r => setAgents(r.agents)); }, []);
  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => { if (evt.type?.startsWith("agent_")) reload(); });

  return (
    <div class="detail">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="margin:0">Agents</h2>
        <a href="#/agents/new" class="primary" style="padding:6px 10px;border-radius:4px;background:var(--accent);color:#fff;text-decoration:none">+ New agent</a>
      </div>
      {agents.length === 0 && <div class="meta">No agents yet. Create one to assign to tasks.</div>}
      <ul style="list-style:none;padding:0">
        {agents.map(a => (
          <li key={a.name} class="task-card" style="margin-bottom:8px">
            <a href={`#/agents/${a.name}`} style="color:inherit;text-decoration:none">
              <h4>{a.display_name} <span class="meta">({a.name})</span></h4>
              <div class="meta">{a.sdk}:{a.model} · effort {a.effort} · {a.enabled ? "enabled" : "disabled"}</div>
              {a.description && <div style="margin-top:4px">{a.description}</div>}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
