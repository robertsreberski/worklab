import { effectiveTeamForTask } from "./teams.js";
import { getTeamRosterAgentNames } from "./db/queries/teams.js";

function safeParseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function numberSetting(settings, key, fallback) {
  const value = Number(settings?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function delegationDepth(db, task) {
  let depth = 0;
  let parentId = task?.parent_task_id || null;
  const seen = new Set([task?.id].filter(Boolean));
  while (parentId && depth < 100) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = db.prepare("SELECT id, parent_task_id FROM tasks WHERE id = ?").get(parentId);
    if (!parent) break;
    depth += 1;
    parentId = parent.parent_task_id || null;
  }
  return depth;
}

export function enabledDelegationAgents(db) {
  return db.prepare(`
    SELECT name, display_name, description, sdk, model, effort
    FROM agents
    WHERE enabled = 1
    ORDER BY name ASC
  `).all().map((row) => ({
    name: row.name,
    display_name: row.display_name || row.name,
    description: row.description || "",
    sdk: row.sdk || "",
    model: row.model || "",
    effort: row.effort || "",
  }));
}

export function loadChildTaskSummaries(db, taskId) {
  if (!taskId) return [];
  const rows = db.prepare(`
    SELECT
      t.id, t.task_key, t.title, t.stage, t.stage_reason,
      t.owner_agent, t.reviewer_agent, t.completed_at,
      t.last_failure_kind, t.updated_at,
      e.required AS required, e.edge_type AS edge_type
    FROM task_edges e
    JOIN tasks t ON t.id = e.child_task_id
    WHERE e.parent_task_id = ? AND e.edge_type = 'subtask'
    ORDER BY t.subtask_order ASC, t.created_at ASC
  `).all(taskId);

  const latestRun = db.prepare(`
    SELECT id, mode, stage, status, process_status, decision, failure_kind,
           summary, details, result_json, artifact_summary_json, started_at, ended_at
    FROM task_runs
    WHERE task_id = ?
    ORDER BY started_at DESC, rowid DESC
    LIMIT 1
  `);

  return rows.map((row) => {
    const run = latestRun.get(row.id);
    return {
      id: row.id,
      task_key: row.task_key || null,
      title: row.title,
      stage: row.stage || "plan",
      stage_reason: row.stage_reason || null,
      owner_agent: row.owner_agent || null,
      reviewer_agent: row.reviewer_agent || null,
      required: row.required !== 0,
      completed_at: row.completed_at || null,
      last_failure_kind: row.last_failure_kind || null,
      updated_at: row.updated_at || null,
      latest_run: run ? {
        id: run.id,
        mode: run.mode,
        stage: run.stage,
        status: run.status,
        process_status: run.process_status,
        decision: run.decision || null,
        failure_kind: run.failure_kind || null,
        summary: run.summary || null,
        details: run.details || null,
        result: safeParseJson(run.result_json, null),
        artifact_summary: safeParseJson(run.artifact_summary_json, {}),
        started_at: run.started_at || null,
        ended_at: run.ended_at || null,
      } : null,
    };
  });
}

export function buildDelegationContext({ db, task, settings }) {
  const enabled = settings?.delegation_enabled !== false;
  const maxDepth = numberSetting(settings, "delegation_max_depth", 1);
  const maxChildrenPerRound = numberSetting(settings, "delegation_max_children_per_round", 5);
  const maxParallelChildren = numberSetting(settings, "delegation_max_parallel_children", 3);
  const autoRunChildren = settings?.delegation_auto_run_children !== false;
  const depth = delegationDepth(db, task);
  const childTasks = loadChildTaskSummaries(db, task?.id);
  const activeChildCount = childTasks.filter((child) => !["done", "blocked"].includes(child.stage)).length;
  const canDelegate = enabled && depth < maxDepth;
  const teamId = effectiveTeamForTask(db, task);
  const teamRoster = teamId ? new Set(getTeamRosterAgentNames(db, teamId)) : null;
  const availableAgents = enabledDelegationAgents(db).filter((agent) => !teamRoster || teamRoster.has(agent.name));
  const disabledReason = !enabled
    ? "delegation disabled by settings"
    : depth >= maxDepth
      ? `delegation depth limit reached (${depth}/${maxDepth})`
      : null;

  return {
    enabled,
    canDelegate,
    disabledReason,
    depth,
    maxDepth,
    maxChildrenPerRound,
    maxParallelChildren,
    autoRunChildren,
    activeChildCount,
    teamId,
    availableAgents,
    childTasks,
  };
}
