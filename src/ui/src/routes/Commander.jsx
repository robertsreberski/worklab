// §6.2 Commander — primary working surface.
// Filter bar: Search · stage Tabs · "New task". Grouped by stage. Uses
// CommanderRow (§4.4). States: loading / empty / empty-after-filter / error.

import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { formatCost } from "../lib/runFormatting.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { SearchField } from "../components/primitives/SearchField.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Icon } from "../components/Icon.jsx";
import { CommanderRow } from "../components/CommanderRow.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { ErrorState } from "../components/ErrorState.jsx";
import { Modal } from "../components/Modal.jsx";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { navigateHash } from "../lib/navigation.js";
import { agentModelEffortLabel, taskRouteId } from "../lib/display.js";
import { pushToast } from "../lib/toast.js";

const STAGE_GROUP_KEYS = ["plan", "execute", "review", "awaiting_children", "awaiting_user", "blocked", "done"];

function DailyCostChip() {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    let cancelled = false;
    function load() {
      api.get("/api/runs/cost-summary").then((res) => {
        if (!cancelled && res?.today) setSummary(res);
      }).catch(() => {});
    }
    load();
    const handle = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);
  if (!summary?.today || !Number.isFinite(summary.today.total_usd) || summary.today.run_count === 0) return null;
  const todayLabel = formatCost(summary.today.total_usd);
  const weekLabel = formatCost(summary.week.total_usd);
  const titleLines = [`Today: ${todayLabel} across ${summary.today.run_count} run${summary.today.run_count === 1 ? "" : "s"}`];
  if (summary.week.run_count > summary.today.run_count) {
    titleLines.push(`This week: ${weekLabel} across ${summary.week.run_count} runs`);
  }
  for (const row of summary.today_by_agent || []) {
    titleLines.push(`  - ${row.agent || "unattributed"}: ${formatCost(row.total_usd)}`);
  }
  return (
    <span class="commander-cost-chip" title={titleLines.join("\n")}>
      {todayLabel} today
    </span>
  );
}

const GROUPS = [
  { key: "plan",            label: "Plan",        color: "var(--accent)",          icon: "◉" },
  { key: "execute",         label: "Execute",     color: "var(--status-todo)",     icon: "○" },
  { key: "review",          label: "Review",      color: "var(--status-review)",   icon: "◉" },
  { key: "awaiting_children", label: "Waiting",   color: "var(--status-progress)", icon: "◐" },
  { key: "awaiting_user",   label: "Needs input", color: "var(--status-error)",    icon: "▲" },
  { key: "blocked",         label: "Blocked",     color: "var(--status-error)",    icon: "▲" },
  { key: "automated",       label: "Automated",   color: "var(--status-progress)", icon: "◐" },
  { key: "done",            label: "Done",        color: "var(--status-done)",     icon: "●" },
];

export function groupKeyFor(task) {
  const stage = task.stage || "plan";
  if (stage === "done" && Number(task.automation_summary?.enabled_count || 0) > 0) {
    return "automated";
  }
  if (STAGE_GROUP_KEYS.includes(stage)) {
    return stage;
  }
  return "execute";
}

export function taskMatchesCommanderQuery(task, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return (
    task.title?.toLowerCase().includes(q) ||
    task.instructions?.toLowerCase().includes(q) ||
    task.task_key?.toLowerCase().includes(q) ||
    task.id?.toLowerCase().includes(q) ||
    task.owner_agent?.toLowerCase().includes(q) ||
    task.planner_agent?.toLowerCase().includes(q) ||
    task.reviewer_agent?.toLowerCase().includes(q)
  );
}

const TABS = [
  { value: "all", label: "All" },
  { value: "plan", label: "Plan" },
  { value: "execute", label: "Execute" },
  { value: "review", label: "Review" },
  { value: "awaiting_children", label: "Waiting" },
  { value: "awaiting_user", label: "Needs input" },
  { value: "blocked", label: "Blocked" },
  { value: "automated", label: "Automated" },
  { value: "done", label: "Done" },
];

const BULK_STAGE_OPTIONS = GROUPS
  .filter((group) => STAGE_GROUP_KEYS.includes(group.key))
  .map((group) => ({ value: group.key, label: group.label }));

const BULK_RUN_POLICY_OPTIONS = [
  { value: "auto_plan_execute", label: "Auto" },
  { value: "manual", label: "Manual" },
];

function agentBulkOptions(agents) {
  return [
    { value: "__unassigned__", label: "Unassigned" },
    ...agents.map((agent) => {
      const metadata = agentModelEffortLabel(agent);
      return {
        value: agent.name,
        label: agent.display_name || agent.name,
        description: [
          agent.enabled === false ? "disabled" : null,
          metadata || null,
        ].filter(Boolean).join(" · ") || undefined,
      };
    }),
  ];
}

function BulkTaskBar({
  count,
  visibleCount,
  agents,
  busy,
  onClear,
  onSelectVisible,
  onPatch,
  onDelete,
}) {
  const agentOptions = useMemo(() => agentBulkOptions(agents), [agents]);

  return (
    <div class="commander-bulkbar" role="region" aria-label="Bulk task actions">
      <div class="commander-bulkbar-summary">
        <Icon name="check-circle" size={14} />
        <strong>{count}</strong>
        <span>{count === 1 ? "task selected" : "tasks selected"}</span>
      </div>
      <div class="commander-bulkbar-actions">
        <Button size="sm" variant="ghost" iconLeft={<Icon name="x" size={12} />} disabled={busy} onClick={onClear}>
          Clear
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || visibleCount === 0} onClick={onSelectVisible}>
          Select visible
        </Button>
        <Select
          class="bulk-action-select"
          variant="native"
          value=""
          placeholder="Stage"
          ariaLabel="Bulk change stage"
          disabled={busy}
          options={BULK_STAGE_OPTIONS}
          onChange={(value) => value && onPatch({ stage: value })}
        />
        <Select
          class="bulk-action-select"
          variant="menu"
          value=""
          placeholder="Owner"
          ariaLabel="Bulk assign owner"
          disabled={busy}
          options={agentOptions}
          onChange={(value) => onPatch({ owner_agent: value === "__unassigned__" ? null : value })}
        />
        <Select
          class="bulk-action-select"
          variant="menu"
          value=""
          placeholder="Planner"
          ariaLabel="Bulk assign planner"
          disabled={busy}
          options={agentOptions}
          onChange={(value) => onPatch({ planner_agent: value === "__unassigned__" ? null : value })}
        />
        <Select
          class="bulk-action-select"
          variant="menu"
          value=""
          placeholder="Reviewer"
          ariaLabel="Bulk assign reviewer"
          disabled={busy}
          options={agentOptions}
          onChange={(value) => onPatch({ reviewer_agent: value === "__unassigned__" ? null : value })}
        />
        <Select
          class="bulk-action-select bulk-action-select-wide"
          variant="native"
          value=""
          placeholder="Run mode"
          ariaLabel="Bulk change run mode"
          disabled={busy}
          options={BULK_RUN_POLICY_OPTIONS}
          onChange={(value) => value && onPatch({ run_policy: value })}
        />
        <Button
          size="sm"
          variant="destructive"
          iconLeft={<Icon name="trash" size={12} />}
          disabled={busy}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

export function Commander() {
  const [tasks, setTasks] = useState(null);
  const [agents, setAgents] = useState([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [checkedIds, setCheckedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [listOwnsFocus, setListOwnsFocus] = useState(false);
  const searchRef = useRef(null);

  const reload = useCallback(() => {
    setError(null);
    return api.listTasks()
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

  useEffect(() => {
    if (!tasks) return;
    const validIds = new Set(tasks.map((task) => task.id));
    setCheckedIds((current) => {
      if (current.size === 0) return current;
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [tasks]);

  const withGroup = useMemo(() => {
    return (tasks || []).map((t) => ({ task: t, group: groupKeyFor(t) }));
  }, [tasks]);

  const counts = useMemo(() => {
    const c = { all: withGroup.length };
    for (const { group } of withGroup) c[group] = (c[group] || 0) + 1;
    return c;
  }, [withGroup]);

  const filtered = useMemo(() => {
    return withGroup.filter(({ task, group }) => {
      if (statusFilter !== "all" && group !== statusFilter) return false;
      return taskMatchesCommanderQuery(task, query);
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
  const checkedTaskIds = useMemo(() => [...checkedIds], [checkedIds]);
  const visibleTaskIds = useMemo(() => orderedTasks.map((task) => task.id), [orderedTasks]);

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
      const selectedTask = orderedTasks.find((task) => task.id === selectedTaskId);
      navigateHash(`#/tasks/${taskRouteId(selectedTask)}`);
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

  const tabsWithCounts = TABS.map((t) => ({ ...t, count: counts[t.value] || 0 }));

  const hasFilter = statusFilter !== "all" || !!query.trim();

  const taskCountLabel = tasks ? `${counts.all || 0} tasks` : null;

  async function applyBulk(operation, patch) {
    if (checkedTaskIds.length === 0) return;
    setBulkBusy(true);
    try {
      const payload = { ids: checkedTaskIds, operation };
      if (patch) payload.patch = patch;
      const result = await api.bulkTasks(payload);
      const failedIds = result.results?.filter((entry) => !entry.ok).map((entry) => entry.id) || [];
      const summary = result.summary || { succeeded: 0, failed: failedIds.length };
      if (summary.failed > 0) {
        pushToast(`${summary.succeeded} succeeded, ${summary.failed} failed`, { variant: "error" });
      } else {
        pushToast(operation === "delete" ? "Tasks deleted" : "Tasks updated", { variant: "success" });
      }
      setCheckedIds(new Set(failedIds));
      await reload();
    } catch (err) {
      pushToast(`Bulk action failed: ${err.message}`, { variant: "error" });
    } finally {
      setBulkBusy(false);
    }
  }

  function selectVisibleTasks() {
    setCheckedIds((current) => {
      const next = new Set(current);
      for (const id of visibleTaskIds) next.add(id);
      return next;
    });
  }

  return (
    <AppShell route="tasks">
      <div class="commander">
        <div class="commander-topbar">
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
            <div class="commander-filter-actions">
              <DailyCostChip />
              {taskCountLabel && <span class="commander-filter-count">{taskCountLabel}</span>}
              <Button class="commander-new-task-inline" variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { navigateHash("#/tasks/new"); }}>
                New task
              </Button>
            </div>
          </div>
          {checkedTaskIds.length > 0 && (
            <BulkTaskBar
              count={checkedTaskIds.length}
              visibleCount={visibleTaskIds.length}
              agents={agents}
              busy={bulkBusy}
              onClear={() => setCheckedIds(new Set())}
              onSelectVisible={selectVisibleTasks}
              onPatch={(patch) => applyBulk("patch", patch)}
              onDelete={() => setBulkDeleteOpen(true)}
            />
          )}
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
                    onOpen={() => navigateHash(`#/tasks/${taskRouteId(task)}`)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
        <Button
          class="commander-new-task-fab"
          variant="primary"
          iconLeft={<Icon name="plus" size={22} />}
          aria-label="New task"
          title="New task"
          onClick={() => { navigateHash("#/tasks/new"); }}
        />
      </div>
      <Modal
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        title={`Delete ${checkedTaskIds.length} ${checkedTaskIds.length === 1 ? "task" : "tasks"}?`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" disabled={bulkBusy} onClick={() => setBulkDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              loading={bulkBusy}
              onClick={() => {
                setBulkDeleteOpen(false);
                applyBulk("delete");
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p>This permanently removes the selected tasks and their runs. This action cannot be undone.</p>
      </Modal>
    </AppShell>
  );
}
