// src/ui/src/routes/Agents.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { Icon } from "../components/Icon.jsx";
import { StatusSignal } from "../components/StatusSignal.jsx";
import { humanizeSlug, modelDisplayName } from "../lib/display.js";

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
          <div class="page-copy">{agents.length} configured / {agents.filter((agent) => agent.enabled).length} available</div>
        </div>
        <a href="#/agents/new" class="primary"><Icon name="plus" size={15} />New agent</a>
      </div>
      {agents.length === 0 && <div class="meta">No agents yet. Create one to assign to tasks.</div>}
      <div class="entity-list">
        {agents.map(a => (
          <a key={a.name} href={`#/agents/${a.name}`} class="entity-row">
            <div class="entity-avatar" aria-hidden="true">{(a.display_name || a.name || "A").slice(0, 1).toUpperCase()}</div>
            <div class="entity-row-main">
              <h4>{a.display_name || humanizeSlug(a.name)}</h4>
              <div class="entity-row-subtitle">{a.description || "No description yet."}</div>
              <div class="entity-row-meta">
                <span>{modelDisplayName(a.model)}</span>
                <span>Effort {a.effort}</span>
              </div>
            </div>
            <StatusSignal tone={a.enabled ? "green" : "muted"}>{a.enabled ? "Available" : "Unavailable"}</StatusSignal>
          </a>
        ))}
      </div>
    </div>
  );
}
