export const RUNTIME_TASK_GROUPS = [
  { key: "running", label: "Running" },
  { key: "attention", label: "Needs attention" },
  { key: "ready", label: "Ready" },
  { key: "waiting", label: "Waiting" },
  { key: "automated", label: "Automated" },
  { key: "completed", label: "Completed" },
];

export const RUNTIME_TASK_GROUP_KEYS = RUNTIME_TASK_GROUPS.map((group) => group.key);

export function taskHasRunningRun(task = {}) {
  if (task.running_run_id) return true;
  if ((task.running_run?.process_status || task.running_run?.status) === "running") return true;
  return Array.isArray(task.runs) && task.runs.some((run) => (run?.process_status || run?.status) === "running");
}

export function taskHasEnabledAutomation(task = {}) {
  return Number(task.automation_summary?.enabled_count || 0) > 0;
}

export function taskHasRunError(task = {}) {
  if (!task || taskHasRunningRun(task)) return false;
  if (task.last_run?.status === "error" || task.last_run?.process_status === "failed" || task.last_run?.process_status === "abandoned") {
    return true;
  }
  if (Array.isArray(task.runs) && task.runs.length) {
    const last = task.runs[task.runs.length - 1];
    return last?.status === "error" || last?.process_status === "failed" || last?.process_status === "abandoned";
  }
  return false;
}

export function taskRecoveryState(task = {}) {
  const recovery = task?.last_run?.recovery || null;
  return recovery?.active_run_id ? recovery : null;
}

export function taskRecoveryLabel(task = {}) {
  const recovery = taskRecoveryState(task);
  if (!recovery) return null;
  const stage = recovery.stage || task?.stage || task?.last_run?.stage;
  return stage === "review" ? "Retrying review" : "Auto-retrying";
}

export function runtimeTaskAttentionItems(task = {}) {
  const items = [];
  const stage = task.stage || "plan";
  const pendingActions = Array.isArray(task.pending_actions) ? task.pending_actions : [];
  const blockingIssues = Array.isArray(task.blocking_issues) ? task.blocking_issues : [];
  const blockedByCount = Array.isArray(task.blocked_by)
    ? task.blocked_by.filter((dependency) => (dependency.stage || "plan") !== "done").length
    : Number(task.unresolved_dependency_count || 0);

  if (task.running_run_id && task.is_locked === false) {
    items.push({ key: "stuck", label: "Stuck", tone: "error" });
  }
  const recoveryLabel = taskRecoveryLabel(task);
  if (recoveryLabel) {
    items.push({ key: "auto_retry", label: recoveryLabel, tone: "warn" });
  }
  if (taskHasRunError(task)) {
    const kind = task.last_run?.failure_kind || task.last_failure_kind;
    items.push({ key: "failed_run", label: kind ? `Failed: ${kind}` : "Failed run", tone: "error" });
  }
  if (stage === "blocked") {
    items.push({ key: "blocked", label: "Blocked", tone: "error" });
  }
  if (stage === "awaiting_user") {
    items.push({ key: "awaiting_user", label: "Needs input", tone: "error" });
  }
  if (blockingIssues.length > 0) {
    items.push({ key: "blocking_issues", label: `${blockingIssues.length} blocking`, tone: "error" });
  }
  if (pendingActions.length > 0) {
    items.push({ key: "pending_actions", label: `${pendingActions.length} action${pendingActions.length === 1 ? "" : "s"}`, tone: "warn" });
  }
  if (blockedByCount > 0) {
    items.push({ key: "dependencies", label: `Blocked by ${blockedByCount}`, tone: "warn" });
  }
  if (task.last_failure_kind && !taskHasRunError(task)) {
    items.push({ key: "failure_kind", label: `Failure: ${task.last_failure_kind}`, tone: "warn" });
  }
  if (!task.owner_agent && stage !== "done") {
    items.push({ key: "owner", label: "Needs owner", tone: "warn" });
  }

  return items;
}

export function runtimeTaskGroupKey(task = {}) {
  const stage = task.stage || "plan";
  if (taskHasRunningRun(task)) return "running";
  if (stage === "done" && taskHasEnabledAutomation(task)) return "automated";
  if (stage === "done") return "completed";
  if (runtimeTaskAttentionItems(task).length > 0) return "attention";
  if (stage === "awaiting_children") return "waiting";
  return "ready";
}

export function compareRuntimeTasks(a = {}, b = {}) {
  const aRunning = taskHasRunningRun(a);
  const bRunning = taskHasRunningRun(b);
  if (aRunning !== bRunning) return aRunning ? -1 : 1;
  const aAttention = runtimeTaskAttentionItems(a).length > 0;
  const bAttention = runtimeTaskAttentionItems(b).length > 0;
  if (aAttention !== bAttention) return aAttention ? -1 : 1;
  const aDone = a.stage === "done";
  const bDone = b.stage === "done";
  const aTime = Number((aDone ? a.completed_at : null) || a.updated_at || 0);
  const bTime = Number((bDone ? b.completed_at : null) || b.updated_at || 0);
  if (aTime !== bTime) return bTime - aTime;
  return String(a.title || "").localeCompare(String(b.title || ""));
}

export function buildRuntimeTaskSummary(tasks = [], { visibleCompletedCount = null } = {}) {
  const groups = Object.fromEntries(RUNTIME_TASK_GROUPS.map((group) => [group.key, 0]));
  for (const task of tasks || []) {
    const key = runtimeTaskGroupKey(task);
    groups[key] = (groups[key] || 0) + 1;
  }
  const completed = Number(groups.completed || 0);
  const visibleDone = visibleCompletedCount == null ? completed : Math.max(0, Number(visibleCompletedCount || 0));
  return {
    total: tasks.length,
    groups,
    visible_done_count: Math.min(completed, visibleDone),
    hidden_done_count: Math.max(0, completed - visibleDone),
  };
}

export function runtimeTaskVisibility(tasks = [], { doneLimit = 0 } = {}) {
  const limit = Math.max(0, Number.isFinite(Number(doneLimit)) ? Number(doneLimit) : 0);
  const completed = [];
  const visible = [];

  for (const task of tasks || []) {
    if (runtimeTaskGroupKey(task) === "completed") completed.push(task);
    else visible.push(task);
  }

  const sortedCompleted = completed.sort(compareRuntimeTasks);
  const visibleCompleted = sortedCompleted.slice(0, limit);
  return {
    tasks: [...visible, ...visibleCompleted],
    summary: buildRuntimeTaskSummary(tasks, { visibleCompletedCount: visibleCompleted.length }),
  };
}
