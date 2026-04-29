// §6.5 Agents — pane layout. Primary action: New agent.
// PaneRow: avatar · name · sub (model) · status dot (pulse if recent activity).

import { useEffect, useState, useCallback, useMemo, useRef } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Icon } from "../components/Icon.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { PaneListHeader } from "../components/layout/index.js";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LivePulse } from "../components/primitives/LivePulse.jsx";
import { StatusDot } from "../components/primitives/StatusDot.jsx";
import { AgentEdit } from "./AgentEdit.jsx";
import { humanizeSlug, modelDisplayName } from "../lib/display.js";
import { navigateHash } from "../lib/navigation.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";

function agentIsActive(agent) {
  if (!agent.lastRunAt) return false;
  return Date.now() - Number(agent.lastRunAt) < 10 * 60_000;
}

function formatAvgDuration(value) {
  if (!value) return "— avg";
  const ms = Number(value);
  if (ms < 1000) return `${Math.round(ms)}ms avg`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s avg`;
  return `${Math.round(ms / 60_000)}m avg`;
}

export function Agents({ selectedName = null }) {
  const [agents, setAgents] = useState([]);
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);

  const reload = useCallback(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => { if (evt.type?.startsWith("agent_")) reload(); });
  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

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
    <PaneListHeader
      searchValue={query}
      onSearch={setQuery}
      searchPlaceholder="Search agents…"
      searchAriaLabel="Search agents"
      searchRef={searchRef}
      actionLabel="New agent"
      onAction={() => { navigateHash("#/agents/new"); }}
    />
  );

  const listBody = filtered.length === 0 ? (
    query ? (
      <EmptyStateFiltered body="No agents match." onClearFilters={() => setQuery("")} />
    ) : (
      <EmptyState
        title="No agents yet"
        body="Create agents for the roles you want to assign to tasks."
        cta={<Button variant="primary" onClick={() => { navigateHash("#/agents/new"); }}>New agent</Button>}
      />
    )
  ) : (
    filtered.map((a) => {
      const isActive = agentIsActive(a);
      const description = (a.description || "").trim();
      const trailing = (
        <span class="pane-row-summary pane-row-summary-metrics">
          {isActive
            ? <LivePulse size={8} color="var(--status-done)" />
            : <StatusDot status={a.enabled ? "enabled" : "disabled"} size={8} />}
          <span>{a.run_count_30d || 0} runs</span>
          <span>{formatAvgDuration(a.avg_run_duration_ms)}</span>
        </span>
      );
      return (
        <PaneRow
          key={a.name}
          href={`#/agents/${a.name}`}
          active={a.name === selectedName}
          class="agent-pane-row"
          onClick={(event) => {
            event?.preventDefault?.();
            navigateHash(`#/agents/${a.name}`);
          }}
          leading={<AgentAvatar name={a.name} label={a.display_name || a.name} size={28} />}
          title={a.display_name || humanizeSlug(a.name)}
          sub={(
            <span class="pane-row-substack">
              {description && <span class="pane-row-description">{description}</span>}
              <span class="pane-row-subline">
                <span class="pane-row-mono">{modelDisplayName(a.model)}</span>
                {a.effort && (
                  <>
                    <span class="pane-row-dot">·</span>
                    <span>{a.effort} effort</span>
                  </>
                )}
                {!a.enabled && (
                  <>
                    <span class="pane-row-dot">·</span>
                    <span>disabled</span>
                  </>
                )}
              </span>
            </span>
          )}
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
        <p>Open an agent to edit its model, instructions, and tools.</p>
      <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { navigateHash("#/agents/new"); }}>New agent</Button>
      </div>
  );

  return (
    <AppShell route="agents">
      <PaneLayout
        listHeader={listHeader}
        listBody={listBody}
        detail={detail}
        hasSelection={!!selectedName}
        detailOwnsMobileBack={!!selectedName}
        onBack={() => navigateHash("#/agents")}
        backLabel="All agents"
      />
    </AppShell>
  );
}
