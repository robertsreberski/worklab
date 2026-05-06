// §6.2 Commander — primary working surface.
// Filter bar: Search · stage Tabs · "New task". Grouped by stage. Uses
// CommanderRow (§4.4). States: loading / empty / empty-after-filter / error.

import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useThrottledCallback } from "../lib/useThrottledCallback.js";
import { mergeRunEvents } from "../lib/useRunStream.js";
import { pageIsVisible, useAppResume } from "../lib/pageVisibility.js";
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
import { teamPickerOptions } from "../components/TeamPicker.jsx";
import { Modal } from "../components/Modal.jsx";
import { MobileConfigSheet, MobileConfigTrigger } from "../components/MobileConfigSheet.jsx";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { navigateHash } from "../lib/navigation.js";
import { agentModelEffortLabel, taskRouteId } from "../lib/display.js";
import { pushToast } from "../lib/toast.js";
import { writeTaskDetailSummaryCache } from "./task-detail/summaryCache.js";
import {
  compareRuntimeTasks,
  runtimeTaskGroupKey,
} from "../../../core/task-runtime.js";

const STAGE_GROUP_KEYS = ["plan", "execute", "review", "awaiting_children", "awaiting_user", "blocked", "done"];
const HIDDEN_DONE_LIMIT = 0;
const SHOWN_DONE_LIMIT = 200;
const RUN_PROGRESS_PREVIEW_LIMIT = 12;
const COMMANDER_TASK_LIST_CACHE_LIMIT = 4;
const commanderTaskListCache = new Map();

export function formatCommanderCost(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return `$${number.toFixed(2)}`;
}

function labeledRun(count, label) {
  return `${count} ${label} run${count === 1 ? "" : "s"}`;
}

function costSummarySegment(row = {}) {
  const costed = Number(row.run_count || 0);
  const unpriced = Number(row.unpriced_run_count || 0);
  return `${labeledRun(costed, "priced")}${unpriced > 0 ? `, ${labeledRun(unpriced, "unpriced")}` : ""}`;
}

export function formatCommanderCostSummaryTitle(summary) {
  const today = summary?.today || {};
  const week = summary?.week || {};
  const todayLabel = formatCommanderCost(today.total_usd) || "$0.00";
  const weekLabel = formatCommanderCost(week.total_usd) || "$0.00";
  const lines = [`Today: ${todayLabel} across ${costSummarySegment(today)}`];
  if (Number(week.run_count || 0) > Number(today.run_count || 0)
    || Number(week.unpriced_run_count || 0) > Number(today.unpriced_run_count || 0)) {
    lines.push(`This week: ${weekLabel} across ${costSummarySegment(week)}`);
  }
  for (const row of summary?.today_by_agent || []) {
    lines.push(`  - ${row.agent || "unattributed"}: ${formatCommanderCost(row.total_usd) || "$0.00"} (${costSummarySegment(row)})`);
  }
  return lines;
}

export function formatCommanderCostChipLabel(summary) {
  const today = summary?.today;
  if (!today || !Number.isFinite(Number(today.total_usd))) return null;
  const costed = Number(today.run_count || 0);
  const unpriced = Number(today.unpriced_run_count || 0);
  if (costed > 0) return `${formatCommanderCost(today.total_usd)} today`;
  if (unpriced > 0) return `${unpriced} unpriced today`;
  return null;
}

function DailyCostChip() {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    let cancelled = false;
    function load() {
      api.getRunCostSummary().then((res) => {
        if (!cancelled && res?.today) setSummary(res);
      }).catch(() => {});
    }
    load();
    const handle = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);
  const chipLabel = formatCommanderCostChipLabel(summary);
  if (!chipLabel) return null;
  const titleLines = formatCommanderCostSummaryTitle(summary);
  return (
    <span class="commander-cost-chip" title={titleLines.join("\n")}>
      {chipLabel}
    </span>
  );
}

export const STAGE_GROUPS = [
  { key: "plan",            label: "Plan",        color: "var(--accent)",          icon: "◉" },
  { key: "execute",         label: "Execute",     color: "var(--status-todo)",     icon: "○" },
  { key: "review",          label: "Review",      color: "var(--status-review)",   icon: "◆" },
  { key: "awaiting_children", label: "Waiting",   color: "var(--status-progress)", icon: "□" },
  { key: "awaiting_user",   label: "Needs input", color: "var(--status-error)",    icon: "▲" },
  { key: "blocked",         label: "Blocked",     color: "var(--status-error)",    icon: "■" },
  { key: "automated",       label: "Automated",   color: "var(--status-progress)", icon: "◷" },
  { key: "done",            label: "Done",        color: "var(--status-done)",     icon: "✓" },
];

export const RUNTIME_GROUPS = [
  { key: "running", label: "Running", color: "var(--status-progress)", icon: "zap" },
  { key: "attention", label: "Needs attention", color: "var(--status-error)", icon: "alert-triangle" },
  { key: "ready", label: "Ready", color: "var(--accent)", icon: "play" },
  { key: "waiting", label: "Waiting", color: "var(--status-progress)", icon: "clock" },
  { key: "automated", label: "Automated", color: "var(--status-progress)", icon: "calendar" },
  { key: "completed", label: "Completed", color: "var(--status-done)", icon: "check-circle" },
];

const STAGE_GROUP_ORDER = Object.fromEntries(STAGE_GROUPS.map((group, index) => [group.key, index]));
const RUNTIME_GROUP_KEYS = RUNTIME_GROUPS.map((group) => group.key);
const IN_PROGRESS_STAGES = new Set(["execute", "review", "awaiting_children", "awaiting_user", "blocked"]);

function taskHasRunningRun(task) {
  if (!task) return false;
  if (task.running_run_id) return true;
  if ((task.running_run?.process_status || task.running_run?.status) === "running") return true;
  return Array.isArray(task.runs) && task.runs.some((run) => (run?.process_status || run?.status) === "running");
}

export function commanderTaskSortBucket(task) {
  if (taskHasRunningRun(task)) return 0;
  const stage = task?.stage || "plan";
  if (IN_PROGRESS_STAGES.has(stage)) return 1;
  if (stage === "plan") return 2;
  return 3;
}

export function compareCommanderTasks(a = {}, b = {}) {
  const bucketDelta = commanderTaskSortBucket(a) - commanderTaskSortBucket(b);
  if (bucketDelta) return bucketDelta;
  const updatedDelta = Number(b.updated_at || 0) - Number(a.updated_at || 0);
  if (updatedDelta) return updatedDelta;
  return String(a.title || "").localeCompare(String(b.title || ""));
}

export function compareCommanderGroups(a = {}, b = {}) {
  const aBucket = Math.min(...(a.tasks || []).map(commanderTaskSortBucket));
  const bBucket = Math.min(...(b.tasks || []).map(commanderTaskSortBucket));
  if (aBucket !== bBucket) return aBucket - bBucket;
  return (STAGE_GROUP_ORDER[a.status] ?? 99) - (STAGE_GROUP_ORDER[b.status] ?? 99);
}

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
    task.reviewer_agent?.toLowerCase().includes(q) ||
    task.project?.name?.toLowerCase().includes(q) ||
    task.project?.slug?.toLowerCase().includes(q)
  );
}

const RUNTIME_TABS = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "attention", label: "Attention" },
  { value: "ready", label: "Ready" },
  { value: "waiting", label: "Waiting" },
  { value: "automated", label: "Automated" },
];

const STAGE_FILTER_OPTIONS = [
  { value: "all", label: "All stages" },
  ...STAGE_GROUPS
    .filter((group) => STAGE_GROUP_KEYS.includes(group.key))
    .map((group) => ({ value: group.key, label: group.label })),
];

const BULK_STAGE_OPTIONS = STAGE_GROUPS
  .filter((group) => STAGE_GROUP_KEYS.includes(group.key))
  .map((group) => ({ value: group.key, label: group.label }));

const BULK_RUN_POLICY_OPTIONS = [
  { value: "auto_plan_execute", label: "Auto" },
  { value: "manual", label: "Manual" },
];

export function agentBulkOptions(agents) {
  return [
    { value: "__unassigned__", label: "Unassigned" },
    ...agents.filter((agent) => agent.enabled !== false).map((agent) => {
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

function normalizeRuntimeGroup(value) {
  if (value === "done") return "completed";
  if (RUNTIME_GROUP_KEYS.includes(value)) return value;
  return "all";
}

function showCompletedFromQuery(query = {}) {
  return query.show_completed === "1"
    || query.show_completed === "true"
    || query.scope === "all"
    || query.group === "done"
    || query.group === "completed";
}

function initialRuntimeGroupFilter(routeQuery = {}) {
  return normalizeRuntimeGroup(
    routeQuery.group === "done" || routeQuery.group === "completed" ? "all" : routeQuery.group || "all",
  );
}

function commanderTaskListIncludesCompleted({
  showCompleted = false,
  groupFilter = "all",
  stageFilter = "all",
} = {}) {
  return showCompleted || stageFilter === "done" || groupFilter === "completed";
}

export function commanderTaskListRequestQuery(filters = {}) {
  return {
    scope: "runtime",
    done_limit: String(commanderTaskListIncludesCompleted(filters) ? SHOWN_DONE_LIMIT : HIDDEN_DONE_LIMIT),
  };
}

export function commanderTaskListCacheKey(filters = {}) {
  return `runtime:${commanderTaskListRequestQuery(filters).done_limit}`;
}

export function readCommanderTaskListCache(cacheKey) {
  const snapshot = commanderTaskListCache.get(cacheKey);
  if (!snapshot) return null;
  return {
    tasks: [...(snapshot.tasks || [])],
    summary: snapshot.summary || null,
  };
}

export function writeCommanderTaskListCache(cacheKey, snapshot = {}) {
  if (!cacheKey) return;
  if (commanderTaskListCache.has(cacheKey)) commanderTaskListCache.delete(cacheKey);
  commanderTaskListCache.set(cacheKey, {
    tasks: [...(snapshot.tasks || [])],
    summary: snapshot.summary || null,
  });
  while (commanderTaskListCache.size > COMMANDER_TASK_LIST_CACHE_LIMIT) {
    const oldestKey = commanderTaskListCache.keys().next().value;
    commanderTaskListCache.delete(oldestKey);
  }
}

export function clearCommanderTaskListCache() {
  commanderTaskListCache.clear();
}

function BulkTaskBar({
  count,
  visibleCount,
  agents,
  projects,
  teams,
  busy,
  onClear,
  onSelectVisible,
  onRun,
  onPatch,
  onDelete,
}) {
  const agentOptions = useMemo(() => agentBulkOptions(agents), [agents]);
  const projectOptions = useMemo(() => [
    { value: "__none__", label: "No project" },
    ...(projects || [])
      .filter((project) => !project.archived)
      .map((project) => ({
        value: project.id,
        label: project.name,
        description: project.slug,
      })),
  ], [projects]);
  const teamOptions = useMemo(
    () => teamPickerOptions({ teams, value: null, clearLabel: "Project default" }),
    [teams],
  );

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
        <Button size="sm" variant="primary" iconLeft={<Icon name="play" size={12} />} disabled={busy} onClick={onRun}>
          Run
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
        <Select
          class="bulk-action-select bulk-action-select-wide"
          variant="menu"
          value=""
          placeholder="Project"
          ariaLabel="Bulk assign project"
          disabled={busy}
          options={projectOptions}
          onChange={(value) => onPatch({ project_id: value === "__none__" ? null : value })}
        />
        <Select
          class="bulk-action-select bulk-action-select-wide"
          variant="menu"
          value=""
          placeholder="Team"
          ariaLabel="Bulk assign team"
          disabled={busy}
          options={teamOptions}
          onChange={(value) => onPatch({ team_id: value === "__none__" ? null : value })}
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

export function Commander({ query: routeQuery = {} }) {
  const initialShowCompleted = showCompletedFromQuery(routeQuery);
  const initialGroupFilter = initialRuntimeGroupFilter(routeQuery);
  const initialTaskListSnapshot = readCommanderTaskListCache(commanderTaskListCacheKey({
    showCompleted: initialShowCompleted,
    groupFilter: initialGroupFilter,
    stageFilter: "all",
  }));
  const [tasks, setTasks] = useState(() => initialTaskListSnapshot?.tasks || null);
  const [runtimeSummary, setRuntimeSummary] = useState(() => initialTaskListSnapshot?.summary || null);
  const [agents, setAgents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [teams, setTeams] = useState([]);
  const [showCompleted, setShowCompleted] = useState(() => initialShowCompleted);
  const [groupFilter, setGroupFilter] = useState(() => initialGroupFilter);
  const [stageFilter, setStageFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [checkedIds, setCheckedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [listOwnsFocus, setListOwnsFocus] = useState(false);
  const [runProgressEventsByRunId, setRunProgressEventsByRunId] = useState(() => new Map());
  const searchRef = useRef(null);
  const reloadAbortRef = useRef(null);
  const projectsReloadAbortRef = useRef(null);
  const teamsReloadAbortRef = useRef(null);
  const runProgressQueueRef = useRef(new Map());
  const runProgressFrameRef = useRef(null);
  const hiddenTaskReloadRef = useRef(false);
  const hiddenProjectsReloadRef = useRef(false);

  useEffect(() => {
    setShowCompleted(showCompletedFromQuery(routeQuery));
    setGroupFilter(initialRuntimeGroupFilter(routeQuery));
  }, [routeQuery.group, routeQuery.scope, routeQuery.show_completed]);

  const taskListCacheKey = useMemo(() => commanderTaskListCacheKey({
    showCompleted,
    groupFilter,
    stageFilter,
  }), [groupFilter, showCompleted, stageFilter]);

  useEffect(() => {
    const cached = readCommanderTaskListCache(taskListCacheKey);
    if (!cached) return;
    setTasks(cached.tasks);
    setRuntimeSummary(cached.summary);
    setError(null);
  }, [taskListCacheKey]);

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    setError(null);
    const requestQuery = commanderTaskListRequestQuery({ showCompleted, groupFilter, stageFilter });
    return api.listTasks(requestQuery, { signal: controller.signal })
      .then((r) => {
        if (!controller.signal.aborted) {
          const nextTasks = r.tasks || [];
          const nextSummary = r.summary || null;
          for (const task of nextTasks) writeTaskDetailSummaryCache(task);
          writeCommanderTaskListCache(taskListCacheKey, { tasks: nextTasks, summary: nextSummary });
          setTasks(nextTasks);
          setRuntimeSummary(nextSummary);
        }
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        const cached = readCommanderTaskListCache(taskListCacheKey);
        if (cached) {
          setTasks(cached.tasks);
          setRuntimeSummary(cached.summary);
        } else {
          setTasks((current) => current || []);
          setRuntimeSummary((current) => current || null);
        }
        setError(e.message || "Failed to load tasks");
      });
  }, [groupFilter, showCompleted, stageFilter, taskListCacheKey]);
  const reloadSoon = useThrottledCallback(reload, 100);
  const flushRunProgress = useCallback(() => {
    runProgressFrameRef.current = null;
    const queued = runProgressQueueRef.current;
    runProgressQueueRef.current = new Map();
    if (queued.size === 0) return;
    setRunProgressEventsByRunId((current) => {
      const next = new Map(current);
      for (const [runId, events] of queued.entries()) {
        next.set(runId, mergeRunEvents(next.get(runId) || [], events, { limit: RUN_PROGRESS_PREVIEW_LIMIT }));
      }
      return next;
    });
  }, []);
  const queueRunProgress = useCallback((evt) => {
    const existing = runProgressQueueRef.current.get(evt.runId) || [];
    runProgressQueueRef.current.set(evt.runId, [...existing, evt.lastEvent]);
    if (runProgressFrameRef.current) return;
    runProgressFrameRef.current = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(flushRunProgress)
      : setTimeout(flushRunProgress, 16);
  }, [flushRunProgress]);
  const reloadProjects = useCallback(() => {
    projectsReloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    projectsReloadAbortRef.current = controller;
    return api.listProjects(null, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) setProjects(r.projects || []); })
      .catch((e) => { if (e?.name !== "AbortError") setProjects([]); });
  }, []);
  const reloadProjectsSoon = useThrottledCallback(reloadProjects, 100);
  const reloadTeams = useCallback(() => {
    teamsReloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    teamsReloadAbortRef.current = controller;
    return api.listTeams(null, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) setTeams(r.teams || []); })
      .catch((e) => { if (e?.name !== "AbortError") setTeams([]); });
  }, []);
  const reloadTeamsSoon = useThrottledCallback(reloadTeams, 100);
  const refreshOnResume = useCallback(() => {
    if (!pageIsVisible()) return;
    hiddenTaskReloadRef.current = false;
    hiddenProjectsReloadRef.current = false;
    reloadSoon();
    reloadProjectsSoon();
    reloadTeamsSoon();
  }, [reloadProjectsSoon, reloadSoon, reloadTeamsSoon]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const controller = new AbortController();
    api.listAgents({ signal: controller.signal }).then((r) => setAgents(r.agents || [])).catch((e) => { if (e?.name !== "AbortError") setAgents([]); });
    api.listProjects(null, { signal: controller.signal }).then((r) => setProjects(r.projects || [])).catch((e) => { if (e?.name !== "AbortError") setProjects([]); });
    api.listTeams(null, { signal: controller.signal }).then((r) => setTeams(r.teams || [])).catch((e) => { if (e?.name !== "AbortError") setTeams([]); });
    return () => controller.abort();
  }, []);
  useEffect(() => () => {
    reloadAbortRef.current?.abort?.();
    projectsReloadAbortRef.current?.abort?.();
    teamsReloadAbortRef.current?.abort?.();
    if (runProgressFrameRef.current) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(runProgressFrameRef.current);
      else clearTimeout(runProgressFrameRef.current);
    }
  }, []);
  useAppResume(refreshOnResume);
  useSSE("global", (evt) => {
    const visible = pageIsVisible();
    if (evt.type === "run_progress" && evt.runId && evt.lastEvent) {
      if (!visible) return;
      queueRunProgress(evt);
      return;
    }
    if (evt.type === "run_ended" && evt.runId) {
      setRunProgressEventsByRunId((current) => {
        if (!current.has(evt.runId)) return current;
        const next = new Map(current);
        next.delete(evt.runId);
        return next;
      });
    }
    if (["task_created", "task_updated", "task_deleted", "run_started", "run_ended"].includes(evt.type)) {
      if (visible) reloadSoon();
      else hiddenTaskReloadRef.current = true;
    }
    if (evt.type?.startsWith("project_")) {
      if (visible) reloadProjectsSoon();
      else hiddenProjectsReloadRef.current = true;
    }
    if (evt.type?.startsWith("team_")) {
      if (visible) reloadTeamsSoon();
    }
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
    return (tasks || []).map((t) => ({ task: t, group: runtimeTaskGroupKey(t) }));
  }, [tasks]);

  const counts = useMemo(() => {
    const c = { all: withGroup.length };
    for (const { group } of withGroup) c[group] = (c[group] || 0) + 1;
    const hasClientFilter = !!query.trim() || projectFilter !== "all" || stageFilter !== "all";
    if (runtimeSummary?.groups && !hasClientFilter) {
      for (const group of RUNTIME_GROUPS) {
        c[group.key] = runtimeSummary.groups[group.key] || 0;
      }
    }
    return c;
  }, [projectFilter, query, runtimeSummary, stageFilter, withGroup]);

  const filtered = useMemo(() => {
    return withGroup.filter(({ task, group }) => {
      if (groupFilter !== "all" && group !== groupFilter) return false;
      if (stageFilter !== "all" && (task.stage || "plan") !== stageFilter) return false;
      if (projectFilter === "__none__" && task.project_id) return false;
      if (projectFilter !== "all" && projectFilter !== "__none__" && task.project_id !== projectFilter) return false;
      return taskMatchesCommanderQuery(task, query);
    });
  }, [groupFilter, projectFilter, query, stageFilter, withGroup]);

  const grouped = useMemo(() => {
    return RUNTIME_GROUPS
      .map((g) => ({
        status: g.key,
        meta: { label: g.label, color: g.color, icon: g.icon },
        tasks: filtered
          .filter((entry) => entry.group === g.key)
          .map((entry) => entry.task)
          .sort(compareRuntimeTasks),
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

  const tabsWithCounts = RUNTIME_TABS.map((t) => ({ ...t, count: counts[t.value] || 0 }));

  const projectOptions = useMemo(() => [
    { value: "all", label: "All projects" },
    { value: "__none__", label: "No project" },
    ...projects.map((project) => ({
      value: project.id,
      label: project.name,
      description: project.slug,
    })),
  ], [projects]);

  const hasFilter = groupFilter !== "all" || stageFilter !== "all" || projectFilter !== "all" || !!query.trim();

  const taskCountLabel = tasks ? `${filtered.length || 0} shown` : null;
  const activeConfigCount = [groupFilter !== "all", stageFilter !== "all", projectFilter !== "all"].filter(Boolean).length;
  const hiddenDoneCount = !showCompleted ? Number(runtimeSummary?.hidden_done_count || 0) : 0;
  const showCompletedCount = !query.trim() && projectFilter === "all" && stageFilter === "all";
  const completedTotal = Number(runtimeSummary?.groups?.completed || 0);
  const canToggleCompleted = groupFilter === "all" && (showCompleted
    ? completedTotal > 0 || stageFilter === "done"
    : hiddenDoneCount > 0);

  function updateGroupFilter(nextGroup) {
    const normalized = normalizeRuntimeGroup(nextGroup);
    setGroupFilter(normalized);
  }

  function toggleCompleted() {
    navigateHash(showCompleted ? "#/tasks" : "#/tasks?show_completed=1");
  }

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
        const message = operation === "delete"
          ? "Tasks deleted"
          : operation === "run"
            ? `${summary.succeeded} ${summary.succeeded === 1 ? "run" : "runs"} started`
            : "Tasks updated";
        pushToast(message, { variant: "success" });
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
            <MobileConfigTrigger
              class="commander-mobile-config-trigger"
              label="Task list configuration"
              controls="commander-config-sheet"
              expanded={configOpen}
              activeCount={activeConfigCount}
              onClick={() => setConfigOpen(true)}
            />
            <MobileConfigSheet
              id="commander-config-sheet"
              title="Task list configuration"
              open={configOpen}
              onClose={() => setConfigOpen(false)}
              class="commander-config-sheet"
              bodyClass="commander-config-body"
            >
              <Tabs
                ariaLabel="Filter by runtime state"
                value={groupFilter}
                onChange={updateGroupFilter}
                tabs={tabsWithCounts}
                class="tabs-pills"
              />
              <Select
                class="commander-stage-filter"
                variant="menu"
                value={stageFilter}
                onChange={setStageFilter}
                options={STAGE_FILTER_OPTIONS}
                ariaLabel="Filter by exact stage"
              />
              <Select
                class="commander-project-filter"
                variant="menu"
                value={projectFilter}
                onChange={setProjectFilter}
                options={projectOptions}
                placeholder="Project"
                ariaLabel="Filter by project"
              />
              <div class="commander-filter-actions">
                <DailyCostChip />
                {taskCountLabel && <span class="commander-filter-count">{taskCountLabel}</span>}
                <Button class="commander-new-task-inline" variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => { navigateHash("#/tasks/new"); }}>
                  New task
                </Button>
              </div>
            </MobileConfigSheet>
          </div>
          {checkedTaskIds.length > 0 && (
            <BulkTaskBar
              count={checkedTaskIds.length}
              visibleCount={visibleTaskIds.length}
              agents={agents}
              projects={projects}
              teams={teams}
              busy={bulkBusy}
              onClear={() => setCheckedIds(new Set())}
              onSelectVisible={selectVisibleTasks}
              onRun={() => applyBulk("run")}
              onPatch={(patch) => applyBulk("patch", patch)}
              onDelete={() => setBulkDeleteOpen(true)}
            />
          )}
        </div>
        {error && tasks?.length === 0 ? (
          <ErrorState message={error} onRetry={reload} />
        ) : tasks === null ? (
          <LoadingState caption="Loading tasks…" />
        ) : grouped.length === 0 && !canToggleCompleted ? (
          hasFilter ? (
            <EmptyStateFiltered
              title="No tasks match your filter"
              body="Try a different runtime state, exact stage, project, or search."
              onClearFilters={() => { setGroupFilter("all"); setStageFilter("all"); setProjectFilter("all"); setQuery(""); }}
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
                  <span class="group-icon" style={{ color: group.meta.color }} aria-hidden="true">
                    <Icon name={group.meta.icon} size={14} strokeWidth={2} />
                  </span>
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
                    runProgressEvents={runProgressEventsByRunId.get(task.running_run_id) || []}
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
            {canToggleCompleted && (
              <div class="commander-list-footer">
                <Button
                  size="sm"
                  variant="ghost"
                  class="commander-hidden-completed"
                  iconLeft={<Icon name="eye" size={12} />}
                  onClick={toggleCompleted}
                >
                  {showCompleted ? "Hide completed" : "Show completed"}
                  {!showCompleted && showCompletedCount && hiddenDoneCount > 0 && <span class="commander-hidden-completed-count">{hiddenDoneCount}</span>}
                </Button>
              </div>
            )}
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
