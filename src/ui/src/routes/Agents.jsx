import { useEffect, useState, useCallback, useMemo } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { SearchField } from "../components/SearchField.jsx";
import { Icon } from "../components/Icon.jsx";
import { LivePulse } from "../components/primitives/LivePulse.jsx";
import { AgentEdit } from "./AgentEdit.jsx";
import { humanizeSlug, modelDisplayName } from "../lib/display.js";

function agentIsActive(agent) {
  if (!agent.lastRunAt) return false;
  return Date.now() - Number(agent.lastRunAt) < 10 * 60_000;
}

function AgentRow({ agent, active, onSelect }) {
  const isActive = agentIsActive(agent);
  return (
    <a
      href={`#/agents/${agent.name}`}
      class={`pane-row ${active ? "active" : ""}`}
      onClick={onSelect}
    >
      <AgentAvatar name={agent.name} label={agent.display_name || agent.name} size={28} />
      <div class="pane-row-main">
        <div class="pane-row-title">{agent.display_name || humanizeSlug(agent.name)}</div>
        <div class="pane-row-sub">{modelDisplayName(agent.model)}</div>
      </div>
      <div class="pane-row-meta">
        {isActive ? (
          <LivePulse color="var(--green)" size={6} />
        ) : agent.enabled ? (
          <span class="status-dot" style={{ "--dot-color": "var(--green)", "--dot-size": "6px" }} aria-hidden="true" />
        ) : (
          <span class="status-dot" style={{ "--dot-color": "var(--muted-2)", "--dot-size": "6px" }} aria-hidden="true" />
        )}
      </div>
    </a>
  );
}

export function Agents({ selectedName = null }) {
  const [agents, setAgents] = useState([]);
  const [query, setQuery] = useState("");

  const reload = useCallback(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => { if (evt.type?.startsWith("agent_")) reload(); });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => {
      return (
        a.name?.toLowerCase().includes(q) ||
        a.display_name?.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.model?.toLowerCase().includes(q)
      );
    });
  }, [agents, query]);

  const activeCount = agents.filter(agentIsActive).length;
  const enabledCount = agents.filter((a) => a.enabled).length;

  const headerMeta = (
    <>
      <span>{agents.length} configured</span>
      <span class="dot">·</span>
      <span>{enabledCount} enabled</span>
      {activeCount > 0 && (
        <>
          <span class="dot">·</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <LivePulse color="var(--green)" size={6} />
            {activeCount} active
          </span>
        </>
      )}
    </>
  );

  return (
    <AppShell route="agents" title="Agents" headerMeta={headerMeta}>
      <div class="two-pane">
        <aside class="pane-list">
          <div class="pane-list-head">
            <SearchField
              value={query}
              onInput={(e) => setQuery(e.target.value)}
              placeholder="Search agents..."
            />
            <a href="#/agents/new" class="button primary small" style={{ justifyContent: "center" }}>
              <Icon name="plus" size={12} />
              New agent
            </a>
          </div>
          <div class="pane-list-body wl-hide-scrollbar">
            {filtered.length === 0 && (
              <div class="pane-empty">
                {query ? "No agents match." : "No agents yet."}
              </div>
            )}
            {filtered.map((a) => (
              <AgentRow
                key={a.name}
                agent={a}
                active={a.name === selectedName}
              />
            ))}
          </div>
        </aside>
        <section class="pane-detail">
          {selectedName ? (
            <AgentEdit
              key={selectedName}
              name={selectedName}
              onSaved={(name) => {
                reload();
                if (selectedName === "new") window.location.hash = `#/agents/${name}`;
              }}
              onDeleted={() => {
                reload();
                window.location.hash = "#/agents";
              }}
            />
          ) : (
            <div class="pane-empty">
              <Icon name="user" size={28} />
              <h3>Select an agent</h3>
              <p>Pick an agent from the list to view or edit. Or create a new one.</p>
              <a href="#/agents/new" class="button primary">
                <Icon name="plus" size={13} />
                New agent
              </a>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
