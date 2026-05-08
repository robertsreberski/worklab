// §6.5 Agents — pane layout. Primary action: New agent.
// PaneRow: avatar · name · sub (model) · status dot (pulse if recent activity).

import { useEffect, useState, useCallback, useMemo, useRef } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useThrottledCallback } from "../lib/useThrottledCallback.js";
import { useAppResume } from "../lib/pageVisibility.js";
import { AppShell } from "../components/AppShell.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { Icon } from "../components/Icon.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LivePulse } from "../components/primitives/LivePulse.jsx";
import { StatusDot } from "../components/primitives/StatusDot.jsx";
import { ResourceGroup, ResourceListToolbar } from "../components/ResourceListToolbar.jsx";
import { AgentEdit } from "./AgentEdit.jsx";
import { humanizeSlug, modelDisplayName } from "../lib/display.js";
import { agentIsRecent, buildAgentResourceGroups, flattenResourceGroups } from "../lib/resourceLists.js";
import { navigateHash } from "../lib/navigation.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";

function agentIsActive(agent) {
  return agentIsRecent(agent);
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
  const [stateFilter, setStateFilter] = useState("all");
  const [activityFilter, setActivityFilter] = useState("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [effortFilter, setEffortFilter] = useState("all");
  const searchRef = useRef(null);
  const reloadAbortRef = useRef(null);

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    api.listAgents({ signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) setAgents(r.agents || []); })
      .catch((err) => { if (err?.name !== "AbortError") setAgents([]); });
  }, []);
  const reloadSoon = useThrottledCallback(reload, 100);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => () => reloadAbortRef.current?.abort?.(), []);
  useSSE("global", (evt) => { if (evt.type?.startsWith("agent_")) reloadSoon(); });
  useAppResume(reloadSoon);
  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

  const groups = useMemo(() => buildAgentResourceGroups(agents, {
    query,
    state: stateFilter,
    activity: activityFilter,
    model: modelFilter,
    effort: effortFilter,
  }), [activityFilter, agents, effortFilter, modelFilter, query, stateFilter]);
  const filtered = useMemo(() => flattenResourceGroups(groups), [groups]);
  const hasFilter = query.trim() || stateFilter !== "all" || activityFilter !== "all" || modelFilter !== "all" || effortFilter !== "all";
  const stateTabs = useMemo(() => [
    { value: "all", label: "All", count: agents.length },
    { value: "enabled", label: "Enabled", count: agents.filter((agent) => agent.enabled !== false).length },
    { value: "disabled", label: "Disabled", count: agents.filter((agent) => agent.enabled === false).length },
  ], [agents]);
  const modelOptions = useMemo(() => [
    { value: "all", label: "All models" },
    ...[...new Set(agents.map((agent) => agent.model).filter(Boolean))]
      .sort((a, b) => modelDisplayName(a).localeCompare(modelDisplayName(b)))
      .map((model) => ({ value: model, label: modelDisplayName(model), description: model })),
  ], [agents]);
  const effortOptions = useMemo(() => [
    { value: "all", label: "All efforts" },
    ...[...new Set(agents.map((agent) => agent.effort).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .map((effort) => ({ value: effort, label: `${effort} effort` })),
  ], [agents]);
  const activityOptions = [
    { value: "all", label: "All activity" },
    { value: "recent", label: "Recent" },
    { value: "idle", label: "Idle" },
  ];

  const listHeader = (
    <ResourceListToolbar
      searchValue={query}
      onSearch={setQuery}
      searchPlaceholder="Search agents…"
      searchAriaLabel="Search agents"
      searchRef={searchRef}
      countLabel={`${filtered.length} shown`}
      actionLabel="New agent"
      onAction={() => { navigateHash("#/agents/new"); }}
      configTitle="Agents configuration"
      activeConfigCount={[stateFilter !== "all", activityFilter !== "all", modelFilter !== "all", effortFilter !== "all"].filter(Boolean).length}
    >
      <Tabs value={stateFilter} onChange={setStateFilter} tabs={stateTabs} ariaLabel="Filter agents by enabled state" class="tabs-pills" />
      <Select class="resource-filter-select" variant="menu" value={activityFilter} onChange={setActivityFilter} options={activityOptions} ariaLabel="Filter agents by activity" />
      <Select class="resource-filter-select" variant="menu" value={modelFilter} onChange={setModelFilter} options={modelOptions} ariaLabel="Filter agents by model" />
      <Select class="resource-filter-select" variant="menu" value={effortFilter} onChange={setEffortFilter} options={effortOptions} ariaLabel="Filter agents by effort" />
    </ResourceListToolbar>
  );

  const listBody = filtered.length === 0 ? (
    hasFilter ? (
      <EmptyStateFiltered body="No agents match." onClearFilters={() => { setQuery(""); setStateFilter("all"); setActivityFilter("all"); setModelFilter("all"); setEffortFilter("all"); }} />
    ) : (
      <EmptyState
        title="No agents yet"
        body="Create agents for the roles you want to assign to tasks."
        cta={<Button variant="primary" onClick={() => { navigateHash("#/agents/new"); }}>New agent</Button>}
      />
    )
  ) : (
    <div class="resource-list">
      {groups.map((group) => (
        <ResourceGroup key={group.key} group={group}>
          {group.items.map((a) => {
            const isActive = agentIsActive(a);
            const description = (a.description || "").trim();
            const trailing = (
              <span class="pane-row-summary pane-row-summary-metrics">
                {isActive
                  ? <LivePulse size={8} color="var(--status-done)" />
                  : <StatusDot status={a.enabled !== false ? "enabled" : "disabled"} size={8} />}
                <span>{a.run_count_30d || 0} runs</span>
                <span>{formatAvgDuration(a.avg_run_duration_ms)}</span>
              </span>
            );
            return (
              <PaneRow
                key={a.name}
                href={`#/agents/${encodeURIComponent(a.name)}`}
                active={a.name === selectedName}
                class="agent-pane-row"
                onClick={(event) => {
                  event?.preventDefault?.();
                  navigateHash(`#/agents/${encodeURIComponent(a.name)}`);
                }}
                leading={<AgentAvatar name={a.name} label={a.display_name || a.name} size={28} />}
                title={a.display_name || humanizeSlug(a.name)}
                sub={(
                  <span class="pane-row-substack">
                    {description && <span class="pane-row-description">{description}</span>}
                    <span class="resource-row-tags">
                      <span class="pane-row-mono">{modelDisplayName(a.model)}</span>
                      {a.effort && <span class="resource-row-chip">{a.effort} effort</span>}
                      {a.context_window === "1m" && <span class="resource-row-chip">1M context</span>}
                      {a.enabled === false && <span class="resource-row-chip">disabled</span>}
                    </span>
                  </span>
                )}
                trailing={trailing}
              />
            );
          })}
        </ResourceGroup>
      ))}
    </div>
  );

  const detail = selectedName ? (
    <AgentEdit
      key={selectedName}
      name={selectedName}
      onSaved={(name) => {
        reload();
        if (selectedName === "new") window.location.hash = `#/agents/${encodeURIComponent(name)}`;
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
        listFirst
        class="resource-list-layout"
        onBack={() => navigateHash("#/agents")}
        backLabel="All agents"
      />
    </AppShell>
  );
}
