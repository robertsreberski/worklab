import { hasRunError, taskRecoveryLabel } from "./display.js";

export const PROJECT_TASK_GROUPS = [
  { key: "todo", label: "Todo" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

const GROUP_ORDER = Object.fromEntries(PROJECT_TASK_GROUPS.map((group, index) => [group.key, index]));

function emptyGroupCounts() {
  return Object.fromEntries(PROJECT_TASK_GROUPS.map((group) => [group.key, 0]));
}

export function projectTaskGroupKey(task = {}) {
  if (task.running_run_id) return "in_progress";
  if ((task.stage || "plan") === "done") return "done";
  if ((task.stage || "plan") === "plan") return "todo";
  return "in_progress";
}

export function isProjectChildTask(task = {}) {
  return Boolean(task.parent_task_id);
}

export function projectTaskAttentionItems(task = {}) {
  const items = [];
  const stage = task.stage || "plan";
  const pendingActions = Array.isArray(task.pending_actions) ? task.pending_actions : [];
  const blockingIssues = Array.isArray(task.blocking_issues) ? task.blocking_issues : [];
  const runError = hasRunError(task);

  if (task.running_run_id && task.is_locked === false) {
    items.push({ key: "stuck", label: "Stuck", tone: "error", title: "Run is active but not locked by the coordinator" });
  }
  const recoveryLabel = taskRecoveryLabel(task);
  if (recoveryLabel) {
    items.push({ key: "auto_retry", label: recoveryLabel, tone: "warn" });
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
  if (task.last_failure_kind && !runError) {
    items.push({ key: "failure_kind", label: `Failure: ${task.last_failure_kind}`, tone: "warn" });
  }
  if (!task.owner_agent && projectTaskGroupKey(task) !== "done") {
    items.push({ key: "owner", label: "Needs owner", tone: "warn" });
  }

  return items;
}

export function compareProjectTasks(a = {}, b = {}) {
  const aAttention = Array.isArray(a.attention) ? a.attention.length > 0 : projectTaskAttentionItems(a).length > 0;
  const bAttention = Array.isArray(b.attention) ? b.attention.length > 0 : projectTaskAttentionItems(b).length > 0;
  if (aAttention !== bAttention) return aAttention ? -1 : 1;
  const aUpdated = Number(a.updated_at || 0);
  const bUpdated = Number(b.updated_at || 0);
  if (aUpdated !== bUpdated) return bUpdated - aUpdated;
  return String(a.title || "").localeCompare(String(b.title || ""));
}

function summarizeProjectTask(task) {
  return {
    ...task,
    progress_group: projectTaskGroupKey(task),
    attention: projectTaskAttentionItems(task),
  };
}

function childTaskAttentionCount(children) {
  return children.reduce((sum, child) => sum + ((child.attention || []).length > 0 ? 1 : 0), 0);
}

function attachChildTaskSummary(parent, children) {
  const childTasks = [...children].sort(compareProjectTasks);
  const childCounts = emptyGroupCounts();
  for (const child of childTasks) {
    childCounts[child.progress_group] = (childCounts[child.progress_group] || 0) + 1;
  }
  const childAttention = childTaskAttentionCount(childTasks);
  const attention = childAttention > 0
    ? [
        ...(parent.attention || []),
        {
          key: "child_attention",
          label: childAttention === 1 ? "1 child needs attention" : `${childAttention} children need attention`,
          tone: "warn",
        },
      ]
    : (parent.attention || []);

  return {
    ...parent,
    attention,
    child_tasks: childTasks,
    child_count: childTasks.length,
    child_counts: childCounts,
    child_attention_count: childAttention,
  };
}

export function buildProjectTaskProgress(tasks = []) {
  const normalized = Array.isArray(tasks) ? tasks : [];
  const summaries = normalized.map(summarizeProjectTask);
  const byId = new Map(summaries.map((task) => [task.id, task]));
  const childrenByParentId = new Map();
  const primaryTasks = [];

  for (const task of summaries) {
    if (task.parent_task_id && byId.has(task.parent_task_id)) {
      const children = childrenByParentId.get(task.parent_task_id) || [];
      children.push(task);
      childrenByParentId.set(task.parent_task_id, children);
    } else {
      primaryTasks.push(task);
    }
  }

  const groupMap = new Map(PROJECT_TASK_GROUPS.map((group) => [group.key, []]));
  const attentionTasks = [];

  for (const task of primaryTasks) {
    const summary = attachChildTaskSummary(task, childrenByParentId.get(task.id) || []);
    groupMap.get(summary.progress_group)?.push(summary);
    if ((summary.attention || []).length > 0) attentionTasks.push(summary);
  }

  const groups = PROJECT_TASK_GROUPS.map((group) => ({
    ...group,
    tasks: [...(groupMap.get(group.key) || [])].sort(compareProjectTasks),
  }));
  const counts = Object.fromEntries(groups.map((group) => [group.key, group.tasks.length]));
  const total = primaryTasks.length;
  const childTotal = summaries.filter((task) => isProjectChildTask(task)).length;
  const nestedChildTotal = summaries.filter((task) => task.parent_task_id && byId.has(task.parent_task_id)).length;
  const done = counts.done || 0;
  const percentDone = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    total,
    task_total: summaries.length,
    child_total: childTotal,
    nested_child_total: nestedChildTotal,
    counts,
    percent_done: percentDone,
    groups,
    attention_tasks: attentionTasks.sort((a, b) => {
      const groupDelta = (GROUP_ORDER[a.progress_group] ?? 99) - (GROUP_ORDER[b.progress_group] ?? 99);
      return groupDelta || compareProjectTasks(a, b);
    }),
  };
}
