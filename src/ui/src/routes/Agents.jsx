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
    <div class="detail page-stack">
      <div class="page-header">
        <div>
          <div class="eyebrow">Agent registry</div>
          <h2 class="page-title">Agents</h2>
          <div class="page-copy">{agents.length} configured</div>
        </div>
        <a href="#/agents/new" class="primary">New agent</a>
      </div>
      {agents.length === 0 && <div class="meta">No agents yet. Create one to assign to tasks.</div>}
      <div class="list-stack">
        {agents.map(a => (
          <a key={a.name} href={`#/agents/${a.name}`} class="list-row">
            <div class="list-row-main">
              <h4>{a.display_name} <span class="meta">({a.name})</span></h4>
              <div class="meta">{a.model} / effort {a.effort}</div>
              {a.description && <div class="meta">{a.description}</div>}
            </div>
            <span class={a.enabled ? "status-badge done" : "status-badge muted"}>{a.enabled ? "Enabled" : "Disabled"}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
