import { taskRouteId } from "./display.js";

const CATEGORY_ORDER = ["communications", "research", "decision", "runbook", "reference", "howto", "policy", "operations", "plans", "qa", "run-results"];

function timestamp(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : Number(value) || 0;
}

function labelForCategory(value) {
  const text = String(value || "uncategorized").trim() || "uncategorized";
  return text.replace(/[-_]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function compareKnowledge(left, right) {
  if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1;
  return timestamp(right.updated_at) - timestamp(left.updated_at);
}

export function groupProjectKnowledgeEntries(entries = []) {
  const groups = new Map();
  for (const entry of entries || []) {
    if (entry?.auto_promoted || entry?.run_output) continue;
    const key = String(entry?.display_category || entry?.category || "uncategorized").trim() || "uncategorized";
    if (!groups.has(key)) {
      groups.set(key, { key, label: labelForCategory(key), entries: [] });
    }
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, entries: group.entries.sort(compareKnowledge) }))
    .sort((left, right) => {
      const leftRank = CATEGORY_ORDER.indexOf(left.key);
      const rightRank = CATEGORY_ORDER.indexOf(right.key);
      const a = leftRank === -1 ? CATEGORY_ORDER.length : leftRank;
      const b = rightRank === -1 ? CATEGORY_ORDER.length : rightRank;
      if (a !== b) return a - b;
      return left.label.localeCompare(right.label);
    });
}

function artifactLabel(summary = {}) {
  const safeSummary = summary || {};
  const files = Number(safeSummary.files || 0);
  if (!files) return "";
  return `${files} file${files === 1 ? "" : "s"}`;
}

function taskOutputText(run = {}) {
  const safeRun = run || {};
  return String(safeRun.summary || safeRun.details || "").trim();
}

function flattenTasks(tasks = []) {
  const result = [];
  for (const task of tasks || []) {
    if (!task) continue;
    result.push(task);
    if (Array.isArray(task.child_tasks) && task.child_tasks.length) {
      result.push(...flattenTasks(task.child_tasks));
    }
  }
  return result;
}

export function recentProjectTaskOutputs(tasks = [], { limit = 8 } = {}) {
  return flattenTasks(tasks)
    .map((task) => {
      const run = task?.last_run;
      const text = taskOutputText(run);
      const artifacts = artifactLabel(run?.artifact_summary);
      if (!run?.id || (!text && !artifacts)) return null;
      return {
        task_id: task.id,
        task_key: task.task_key || null,
        title: task.title || task.task_key || task.id,
        run_id: run.id,
        agent_name: run.agent_name || null,
        summary: text,
        artifact_label: artifacts,
        ended_at: run.ended_at || task.updated_at || null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => timestamp(right.ended_at) - timestamp(left.ended_at))
    .slice(0, limit);
}

export function buildKnowledgePromotionHash({ project, taskOutput }) {
  const ref = taskOutput?.task_key || taskOutput?.task_id || "task";
  const taskHref = `#/tasks/${taskRouteId({
    id: taskOutput?.task_id,
    task_key: taskOutput?.task_key,
  })}`;
  const body = [
    `Source task: [${ref}](${taskHref})`,
    taskOutput?.run_id ? `Source run: [${taskOutput.run_id}](/api/runs/${encodeURIComponent(taskOutput.run_id)}/raw-log)` : "",
    taskOutput?.agent_name ? `Source agent: ${taskOutput.agent_name}` : "",
    "",
    "## Summary",
    "",
    taskOutput?.summary || "",
  ].filter((line) => line !== null && line !== undefined).join("\n");
  const params = new URLSearchParams({
    title: `${taskOutput?.title || ref} Knowledge Note`,
    category: "research",
    project_id: project?.id || "",
    source_task_id: taskOutput?.task_id || "",
    source_task_key: taskOutput?.task_key || "",
    source_run_id: taskOutput?.run_id || "",
    source_agent: taskOutput?.agent_name || "",
    body,
  });
  return `#/library/knowledge/new?${params.toString()}`;
}
