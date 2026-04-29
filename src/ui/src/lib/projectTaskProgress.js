import { hasRunError } from "./display.js";

export const PROJECT_TASK_GROUPS = [
  { key: "todo", label: "Todo" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

const GROUP_ORDER = Object.fromEntries(PROJECT_TASK_GROUPS.map((group, index) => [group.key, index]));

export function projectTaskGroupKey(task = {}) {
  if (task.running_run_id) return "in_progress";
  if ((task.stage || "plan") === "done") return "done";
  if ((task.stage || "plan") === "plan") return "todo";
  return "in_progress";
}

export function projectTaskAttentionItems(task = {}) {
  const items = [];
  const stage = task.stage || "plan";
  const pendingActions = Array.isArray(task.pending_actions) ? task.pending_actions : [];
  const blockingIssues = Array.isArray(task.blocking_issues) ? task.blocking_issues : [];
  const unresolvedCount = Number(task.unresolved_dependency_count || 0);
  const runError = hasRunError(task);

  if (task.running_run_id && task.is_locked === false) {
    items.push({ key: "stuck", label: "Stuck", tone: "error", title: "Run is active but not locked by the coordinator" });
  }
  if (runError) {
    const kind = task.last_run?.failure_kind || task.last_failure_kind;
    items.push({ key: "failed_run", label: kind ? `Failed: ${kind}` : "Failed run", tone: "error" });
  }
  if (stage === "blocked") {
    items.push({ key: "blocked", label: "Blocked", tone: "error", title: task.stage_reason || task.error_text || undefined });
  }
  if (stage === "awaiting_user") {
    items.push({ key: "awaiting_user", label: "Needs input", tone: "error", title: task.stage_reason || undefined });
  }
  if (blockingIssues.length > 0) {
    items.push({ key: "blocking_issues", label: `${blockingIssues.length} blocking`, tone: "error", title: blockingIssues.join("\n") });
  }
  if (pendingActions.length > 0) {
    items.push({ key: "pending_actions", label: `${pendingActions.length} action${pendingActions.length === 1 ? "" : "s"}`, tone: "warn", title: pendingActions.join("\n") });
  }
  if (unresolvedCount > 0) {
    items.push({ key: "dependencies", label: `Blocked by ${unresolvedCount}`, tone: "warn" });
  }
  if (task.last_failure_kind && !runError) {
    items.push({ key: "failure_kind", label: `Failure: ${task.last_failure_kind}`, tone: "warn" });
  }
  if (!task.owner_agent && projectTaskGroupKey(task) !== "done") {
    items.push({ key: "owner", label: "Needs owner", tone: "warn" });
  }

  return items;
}

export function compareProjectTasks(a = {}, b = {}) {
  const aAttention = projectTaskAttentionItems(a).length > 0;
  const bAttention = projectTaskAttentionItems(b).length > 0;
  if (aAttention !== bAttention) return aAttention ? -1 : 1;
  const aUpdated = Number(a.updated_at || 0);
  const bUpdated = Number(b.updated_at || 0);
  if (aUpdated !== bUpdated) return bUpdated - aUpdated;
  return String(a.title || "").localeCompare(String(b.title || ""));
}

export function buildProjectTaskProgress(tasks = []) {
  const normalized = Array.isArray(tasks) ? tasks : [];
  const groupMap = new Map(PROJECT_TASK_GROUPS.map((group) => [group.key, []]));
  const attentionTasks = [];

  for (const task of normalized) {
    const attention = projectTaskAttentionItems(task);
    const summary = {
      ...task,
      progress_group: projectTaskGroupKey(task),
      attention,
    };
    groupMap.get(summary.progress_group)?.push(summary);
    if (attention.length > 0) attentionTasks.push(summary);
  }

  const groups = PROJECT_TASK_GROUPS.map((group) => ({
    ...group,
    tasks: [...(groupMap.get(group.key) || [])].sort(compareProjectTasks),
  }));
  const counts = Object.fromEntries(groups.map((group) => [group.key, group.tasks.length]));
  const total = normalized.length;
  const done = counts.done || 0;
  const percentDone = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    total,
    counts,
    percent_done: percentDone,
    groups,
    attention_tasks: attentionTasks.sort((a, b) => {
      const groupDelta = (GROUP_ORDER[a.progress_group] ?? 99) - (GROUP_ORDER[b.progress_group] ?? 99);
      return groupDelta || compareProjectTasks(a, b);
    }),
  };
}
