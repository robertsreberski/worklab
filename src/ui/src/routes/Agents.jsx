// §6.5 Agents — pane layout. Primary action: New agent.
// PaneRow: avatar · name · sub (model) · status dot (pulse if recent activity).

import { useEffect, useState, useCallback, useMemo } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { SearchField } from "../components/primitives/SearchField.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Icon } from "../components/Icon.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LivePulse } from "../components/primitives/LivePulse.jsx";
import { StatusDot } from "../components/primitives/StatusDot.jsx";
import { AgentEdit } from "./AgentEdit.jsx";
import { humanizeSlug, modelDisplayName } from "../lib/display.js";

function agentIsActive(agent) {
  if (!agent.lastRunAt) return false;
  return Date.now() - Number(agent.lastRunAt) < 10 * 60_000;
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
    return agents.filter((a) => (
      a.name?.toLowerCase().includes(q) ||
      a.display_name?.toLowerCase().includes(q) ||
      a.description?.toLowerCase().includes(q) ||
      a.model?.toLowerCase().includes(q)
    ));
  }, [agents, query]);

  const listHeader = (
    <>
      <SearchField
        value={query}
        onInput={(e) => setQuery(e.target.value)}
        placeholder="Search agents…"
        ariaLabel="Search agents"
      />
      <Button
        variant="primary"
        size="sm"
        iconLeft={<Icon name="plus" size={12} />}
        onClick={() => { window.location.hash = "#/agents/new"; }}
      >
        New agent
      </Button>
    </>
  );

  const listBody = filtered.length === 0 ? (
    query ? (
      <EmptyStateFiltered body="No agents match." onClearFilters={() => setQuery("")} />
    ) : (
      <EmptyState
        title="No agents yet"
        body="Create your first agent to start orchestrating work."
        cta={<Button variant="primary" onClick={() => { window.location.hash = "#/agents/new"; }}>New agent</Button>}
      />
    )
  ) : (
    filtered.map((a) => {
      const isActive = agentIsActive(a);
      const trailing = isActive
        ? <LivePulse size={8} color="var(--status-done)" />
        : <StatusDot status={a.enabled ? "enabled" : "disabled"} size={8} />;
      return (
        <PaneRow
          key={a.name}
          href={`#/agents/${a.name}`}
          active={a.name === selectedName}
          leading={<AgentAvatar name={a.name} label={a.display_name || a.name} size={28} />}
          title={a.display_name || humanizeSlug(a.name)}
          sub={modelDisplayName(a.model)}
          trailing={trailing}
        />
      );
    })
  );

  const detail = selectedName ? (
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
      <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { window.location.hash = "#/agents/new"; }}>New agent</Button>
    </div>
  );

  return (
    <AppShell route="agents" title="Agents">
      <PaneLayout
        listHeader={listHeader}
        listBody={listBody}
        detail={detail}
        hasSelection={!!selectedName}
      />
    </AppShell>
  );
}
