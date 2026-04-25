// §6.2 Commander — primary working surface.
// Filter bar: Search · stage Tabs · "New task". Grouped by stage. Uses
// CommanderRow (§4.4). States: loading / empty / empty-after-filter / error.

import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { SearchField } from "../components/primitives/SearchField.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Icon } from "../components/Icon.jsx";
import { CommanderRow } from "../components/CommanderRow.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { ErrorState } from "../components/ErrorState.jsx";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { navigateHash } from "../lib/navigation.js";
import { hasRunError } from "../lib/display.js";

const GROUPS = [
  { key: "plan",            label: "Plan",        color: "var(--accent)",          icon: "◉" },
  { key: "execute",         label: "Execute",     color: "var(--status-todo)",     icon: "○" },
  { key: "review",          label: "Review",      color: "var(--status-review)",   icon: "◉" },
  { key: "awaiting_children", label: "Waiting",   color: "var(--status-progress)", icon: "◐" },
  { key: "awaiting_user",   label: "Needs input", color: "var(--status-error)",    icon: "▲" },
  { key: "blocked",         label: "Blocked",     color: "var(--status-error)",    icon: "▲" },
  { key: "done",            label: "Done",        color: "var(--status-done)",     icon: "●" },
];

function groupKeyFor(task) {
  const stage = task.stage || "plan";
  if (["plan", "execute", "review", "awaiting_children", "awaiting_user", "blocked", "done"].includes(stage)) {
    return stage;
  }
  const unmetDeps = Array.isArray(task.blocked_by)
    && task.blocked_by.some((d) => (d.stage || "plan") !== "done");
  const runErrored = hasRunError(task);
  const stuck = task.running_run_id && task.is_locked === false;
  if (unmetDeps || runErrored || stuck) return "blocked";
  return "execute";
}

const TABS = [
  { value: "all", label: "All" },
  { value: "plan", label: "Plan" },
  { value: "execute", label: "Execute" },
  { value: "review", label: "Review" },
  { value: "awaiting_children", label: "Waiting" },
  { value: "awaiting_user", label: "Needs input" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

export function Commander() {
  const [tasks, setTasks] = useState(null);
  const [agents, setAgents] = useState([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [checkedIds, setCheckedIds] = useState(() => new Set());
  const [listOwnsFocus, setListOwnsFocus] = useState(false);
  const searchRef = useRef(null);

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

  const withGroup = useMemo(() => {
    return (tasks || []).map((t) => ({ task: t, group: groupKeyFor(t) }));
  }, [tasks]);

  const counts = useMemo(() => {
    const c = { all: withGroup.length };
    for (const { group } of withGroup) c[group] = (c[group] || 0) + 1;
    return c;
  }, [withGroup]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return withGroup.filter(({ task, group }) => {
      if (statusFilter !== "all" && group !== statusFilter) return false;
      if (!q) return true;
      return (
        task.title?.toLowerCase().includes(q) ||
        task.instructions?.toLowerCase().includes(q) ||
        task.id?.toLowerCase().includes(q) ||
        task.owner_agent?.toLowerCase().includes(q) ||
        task.reviewer_agent?.toLowerCase().includes(q)
      );
    });
  }, [withGroup, statusFilter, query]);

  const grouped = useMemo(() => {
    return GROUPS
      .map((g) => ({
        status: g.key,
        meta: { label: g.label, color: g.color, icon: g.icon },
        tasks: filtered.filter((entry) => entry.group === g.key).map((entry) => entry.task),
      }))
      .filter((g) => g.tasks.length > 0);
  }, [filtered]);
  const orderedTasks = useMemo(() => grouped.flatMap((group) => group.tasks), [grouped]);

  useEffect(() => {
    if (orderedTasks.length === 0) {
      setSelectedTaskId(null);
      return;
    }
    if (!selectedTaskId || !orderedTasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(orderedTasks[0].id);
    }
  }, [orderedTasks, selectedTaskId]);

  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
    j: (event) => {
      if (!listOwnsFocus || orderedTasks.length === 0) return;
      event.preventDefault();
      const currentIndex = Math.max(0, orderedTasks.findIndex((task) => task.id === selectedTaskId));
      const next = orderedTasks[(currentIndex + 1) % orderedTasks.length];
      if (next) setSelectedTaskId(next.id);
    },
    k: (event) => {
      if (!listOwnsFocus || orderedTasks.length === 0) return;
      event.preventDefault();
      const currentIndex = Math.max(0, orderedTasks.findIndex((task) => task.id === selectedTaskId));
      const next = orderedTasks[(currentIndex - 1 + orderedTasks.length) % orderedTasks.length];
      if (next) setSelectedTaskId(next.id);
    },
    Enter: (event) => {
      if (!listOwnsFocus || !selectedTaskId) return;
      event.preventDefault();
      navigateHash(`#/tasks/${selectedTaskId}`);
    },
    x: (event) => {
      if (!listOwnsFocus || !selectedTaskId) return;
      event.preventDefault();
      setCheckedIds((current) => {
        const next = new Set(current);
        if (next.has(selectedTaskId)) next.delete(selectedTaskId);
        else next.add(selectedTaskId);
        return next;
      });
    },
  });

  const headerActions = (
    <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { navigateHash("#/tasks/new"); }}>
      New task
    </Button>
  );

  const tabsWithCounts = TABS.map((t) => ({ ...t, count: counts[t.value] || 0 }));

  const hasFilter = statusFilter !== "all" || !!query.trim();

  const headerMeta = tasks ? <span>{counts.all || 0} tasks</span> : null;

  return (
    <AppShell route="tasks" title="Tasks" headerMeta={headerMeta} headerActions={headerActions}>
      <div class="commander">
        <div class="commander-filter">
          <SearchField
            value={query}
            onInput={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            shortcut="/"
            ariaLabel="Search tasks"
            inputRef={searchRef}
          />
          <div class="filter-divider" />
          <Tabs
            ariaLabel="Filter by stage"
            value={statusFilter}
            onChange={setStatusFilter}
            tabs={tabsWithCounts}
            class="tabs-pills"
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
              body="Try a different stage or clear your search."
              onClearFilters={() => { setStatusFilter("all"); setQuery(""); }}
            />
          ) : (
            <EmptyState
              icon={<Icon name="layout-list" size={48} />}
              title="No tasks yet"
              body="Create a task, assign an owner, and run it when ready."
              cta={
                <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { navigateHash("#/tasks/new"); }}>
                  Create task
                </Button>
              }
            />
          )
        ) : (
          <div
            class="commander-list wl-hide-scrollbar"
            tabIndex={0}
            onFocus={() => setListOwnsFocus(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setListOwnsFocus(false);
            }}
          >
            {grouped.map((group) => (
              <div key={group.status} class="commander-group">
                <div class="commander-group-header">
                  <span class="group-icon" style={{ color: group.meta.color }}>{group.meta.icon}</span>
                  {group.meta.label}
                  <span class="group-count">{group.tasks.length}</span>
                </div>
                {group.tasks.map((task) => (
                  <CommanderRow
                    key={task.id}
                    task={task}
                    agents={agents}
                    selected={task.id === selectedTaskId}
                    checked={checkedIds.has(task.id)}
                    onSelect={() => setSelectedTaskId(task.id)}
                    onToggleCheck={(nextChecked) => {
                      setCheckedIds((current) => {
                        const next = new Set(current);
                        if (nextChecked) next.add(task.id);
                        else next.delete(task.id);
                        return next;
                      });
                    }}
                    onOpen={() => navigateHash(`#/tasks/${task.id}`)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
