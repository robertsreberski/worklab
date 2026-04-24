// §6.2 Commander — primary working surface.
// Filter bar: Search · status Tabs · "New task". Grouped by status. Uses
// CommanderRow (§4.4). States: loading / empty / empty-after-filter / error.

import { useEffect, useMemo, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { SearchField } from "../components/primitives/SearchField.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Icon } from "../components/Icon.jsx";
import { statusMeta } from "../components/primitives/StatusPill.jsx";
import { CommanderRow } from "../components/CommanderRow.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { ErrorState } from "../components/ErrorState.jsx";

const STATUS_ORDER = ["in_progress", "in_review", "todo", "done"];
const TABS = [
  { value: "all",         label: "All" },
  { value: "todo",        label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review",   label: "In review" },
  { value: "done",        label: "Done" },
];

export function Commander() {
  const [tasks, setTasks] = useState(null);
  const [agents, setAgents] = useState([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    setError(null);
    api.listTasks()
      .then((r) => setTasks(r.tasks || []))
      .catch((e) => { setTasks([]); setError(e.message || "Failed to load tasks"); });
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
  }, []);
  useSSE("global", (evt) => {
    if (["task_created", "task_updated", "task_deleted", "run_started", "run_ended"].includes(evt.type)) reload();
  });

  const counts = useMemo(() => {
    const c = { all: (tasks || []).length };
    for (const t of tasks || []) c[t.status] = (c[t.status] || 0) + 1;
    return c;
  }, [tasks]);

  const filtered = useMemo(() => {
    const list = tasks || [];
    const q = query.trim().toLowerCase();
    return list.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (!q) return true;
      return (
        t.title?.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        t.id?.toLowerCase().includes(q) ||
        t.executor_agent?.toLowerCase().includes(q) ||
        t.reviewer_agent?.toLowerCase().includes(q)
      );
    });
  }, [tasks, statusFilter, query]);

  const grouped = useMemo(() => {
    return STATUS_ORDER
      .map((status) => ({
        status,
        meta: statusMeta(status),
        tasks: filtered.filter((t) => t.status === status),
      }))
      .filter((g) => g.tasks.length > 0);
  }, [filtered]);

  const headerActions = (
    <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { window.location.hash = "#/tasks/new"; }}>
      New task
    </Button>
  );

  const tabsWithCounts = TABS.map((t) => ({ ...t, count: counts[t.value] || 0 }));

  const hasFilter = statusFilter !== "all" || !!query.trim();

  return (
    <AppShell route="tasks" title="Tasks" headerActions={headerActions}>
      <div class="commander">
        <div class="commander-filter">
          <SearchField
            value={query}
            onInput={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            shortcut="/"
            ariaLabel="Search tasks"
          />
          <div class="filter-divider" />
          <Tabs
            ariaLabel="Filter by status"
            value={statusFilter}
            onChange={setStatusFilter}
            tabs={tabsWithCounts}
          />
        </div>
        {error && tasks?.length === 0 ? (
          <ErrorState message={error} onRetry={reload} />
        ) : tasks === null ? (
          <LoadingState caption="Loading tasks…" />
        ) : grouped.length === 0 ? (
          hasFilter ? (
            <EmptyStateFiltered
              title="No tasks match your filter"
              body="Try a different status or clear your search."
              onClearFilters={() => { setStatusFilter("all"); setQuery(""); }}
            />
          ) : (
            <EmptyState
              icon={<Icon name="layout-list" size={48} />}
              title="No tasks yet"
              body="Create your first task to start orchestrating agents."
              cta={
                <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { window.location.hash = "#/tasks/new"; }}>
                  Create your first task
                </Button>
              }
            />
          )
        ) : (
          <div class="commander-list wl-hide-scrollbar">
            {grouped.map((group) => (
              <div key={group.status} class="commander-group">
                <div class="commander-group-header">
                  <span class="group-icon" style={{ color: group.meta.color }}>{group.meta.icon}</span>
                  {group.meta.label}
                  <span class="group-count">{group.tasks.length}</span>
                </div>
                {group.tasks.map((task) => (
                  <CommanderRow key={task.id} task={task} agents={agents} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
