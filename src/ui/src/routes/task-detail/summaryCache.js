const TASK_DETAIL_CACHE_LIMIT = 16;
const taskDetailCache = new Map();

function taskDetailCacheKeys(task) {
  return [
    task?.id,
    task?.task_key,
  ].filter(Boolean).map(String);
}

function cloneTaskDetailData(data) {
  if (!data?.task) return null;
  return {
    ...data,
    task: { ...data.task },
    comments: [...(data.comments || [])],
    runs: [...(data.runs || [])],
  };
}

function defaultAutomationSummary() {
  return {
    count: 0,
    enabled_count: 0,
    paused_count: 0,
    next_fire_at: null,
    last_trigger: null,
  };
}

export function taskDetailDataFromTaskSummary(task) {
  if (!task) return null;
  const runningRun = task.running_run || (task.running_run_id ? {
    id: task.running_run_id,
    status: "running",
    process_status: "running",
    started_at: task.running_run_started_at || null,
    agent_name: task.owner_agent || null,
  } : null);
  return {
    task: {
      ...task,
      tags: Array.isArray(task.tags) ? task.tags : [],
      dependency_ids: Array.isArray(task.dependency_ids) ? task.dependency_ids : [],
      blocked_by: Array.isArray(task.blocked_by) ? task.blocked_by : [],
      blocks: Array.isArray(task.blocks) ? task.blocks : [],
      children: Array.isArray(task.children) ? task.children : [],
      automations: Array.isArray(task.automations) ? task.automations : [],
      automation_summary: task.automation_summary || defaultAutomationSummary(),
      artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
      artifact_summary: task.artifact_summary || {},
      plan_body: task.plan_body || "",
      stage: task.stage || "plan",
    },
    comments: [],
    runs: runningRun ? [runningRun] : [],
  };
}

export function writeTaskDetailCache(data) {
  const snapshot = cloneTaskDetailData(data);
  if (!snapshot?.task) return;
  for (const key of taskDetailCacheKeys(snapshot.task)) {
    if (taskDetailCache.has(key)) taskDetailCache.delete(key);
    taskDetailCache.set(key, snapshot);
  }
  while (taskDetailCache.size > TASK_DETAIL_CACHE_LIMIT) {
    taskDetailCache.delete(taskDetailCache.keys().next().value);
  }
}

export function writeTaskDetailSummaryCache(task) {
  const data = taskDetailDataFromTaskSummary(task);
  if (data) writeTaskDetailCache(data);
}

export function readTaskDetailCache(id) {
  const snapshot = taskDetailCache.get(String(id || ""));
  return cloneTaskDetailData(snapshot);
}

export function clearTaskDetailCache() {
  taskDetailCache.clear();
}
