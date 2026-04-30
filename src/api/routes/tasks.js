import {
  applyTaskSideEffects,
  artifactPaths,
  artifactsForRunRow,
  buildNextTaskRunPreview,
  buildRunLifecycleEvent,
  compactProject,
  enrichCommentRows,
  loadTaskArtifacts,
  newCommentId,
  newTaskId,
  nextStage,
  nextTaskKey,
  resolveProjectId,
  resolveProjectRow,
  resolveTaskId,
  resolveTaskRow,
  resumeWaitingParents,
  runArtifactSummary,
  STAGES,
  supportsLiveInputProvider,
  taskStage,
} from "../../core/index.js";
import { renderToolSurfaceMarkdown } from "../../mcp/agent/tools/index.js";

const WORKLAB_TOOL_SURFACE_MARKDOWN = renderToolSurfaceMarkdown(null);
import {
  applyStaleRunReconcileToTask,
  cascadeProjectToDescendants,
  deleteTaskByIdRow,
  getMaxSubtaskOrder,
  getTaskById,
  getTaskByClientRequestId,
  getTaskKeyById,
  insertManualSubtask,
  insertTask,
  listFilteredTasks,
  listTasksByIds,
  markParentAwaitingChildren,
  touchTaskUpdatedAt,
  updateTaskFields,
} from "../../core/db/queries/tasks.js";
import { getAgentLogEvents } from "../../core/db/queries/agent-logs.js";
import {
  applyStaleRunReconcileToRun,
  getCostSummaryByAgentSince,
  getCostSummarySince,
  getLastNonRunningTaskRun,
  getLatestRetryStageRow,
  getLatestTaskRunSummary,
  getRunningRunIdForTask,
  getRunningTaskRun,
  getStaleRunningRunForTask,
  listLastNonRunningRunsForTasks,
  listRunningRunsWithEventsForTasks,
  selectRunsWithLogJoin,
  taskHasRunningRun,
} from "../../core/db/queries/runs.js";
import {
  listBlockedByForTasks,
  listBlocksForTasks,
  listDependsOnTaskIds,
  listDirectDependencyRows,
  listDirectDependentRows,
  replaceDependenciesForTask,
} from "../../core/db/queries/task-dependencies.js";
import {
  insertSubtaskEdge,
  listSubtaskChildrenForParent,
  listSubtaskChildrenForParents,
} from "../../core/db/queries/task-edges.js";
import {
  getLatestAutomationTriggerForTask,
  listAutomationSummariesForTasks,
  listAutomationSummaryForTask,
  listLatestAutomationTriggersForTasks,
} from "../../core/db/queries/automations.js";
import { listProjectsByIds } from "../../core/db/queries/projects.js";
import {
  deleteCommentByIdAndTaskId,
  getCommentById,
  getTaskCommentById,
  insertAuthoredComment,
  listTaskComments,
} from "../../core/db/queries/comments.js";

const RUNS_ORDER_BY = "ORDER BY r.started_at DESC, r.rowid DESC";
const RUN_POLICIES = ["manual", "auto_plan_execute"];
const DEFAULT_RUN_POLICY = "auto_plan_execute";
const RUNNABLE_STAGES = ["plan", "execute", "review"];
const PATCHABLE = ["title", "instructions", "reviewer_agent", "owner_agent", "planner_agent", "tags", "run_policy", "project_id"];
const BULK_PATCHABLE = ["stage", "owner_agent", "planner_agent", "reviewer_agent", "run_policy", "project_id"];

function rowToTask(row) {
  if (!row) return null;
  const stage = row.stage || "plan";
  return {
    ...row,
    stage,
    tags: JSON.parse(row.tags || "[]"),
    failure_count: row.failure_count ?? 0,
    run_policy: row.run_policy || DEFAULT_RUN_POLICY,
    project_id: row.project_id || null,
    root_task_id: row.root_task_id || row.id,
    parent_task_id: row.parent_task_id || null,
    owner_agent: row.owner_agent || null,
    planner_agent: row.planner_agent || null,
    delegated_to_agent: row.delegated_to_agent || null,
    delegated_by_run_id: row.delegated_by_run_id || null,
    plan_body: row.plan_body || "",
    plan_updated_at: row.plan_updated_at || null,
    plan_updated_by: row.plan_updated_by || null,
    plan_source_run_id: row.plan_source_run_id || null,
    required: row.required !== 0,
    pending_actions: JSON.parse(row.pending_actions_json || "[]"),
    blocking_issues: JSON.parse(row.blocking_issues_json || "[]"),
  };
}

function compactTaskSummary(row) {
  const task = rowToTask(row);
  if (!task) return null;
  return {
    id: task.id,
    task_key: task.task_key || null,
    title: task.title,
    stage: task.stage,
    updated_at: task.updated_at,
    owner_agent: task.owner_agent,
    planner_agent: task.planner_agent,
    reviewer_agent: task.reviewer_agent,
    run_policy: task.run_policy,
    project_id: task.project_id || null,
  };
}

function latestTaskRunSummary(db, taskId) {
  const row = getLatestTaskRunSummary(db, taskId);
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    stage: row.stage,
    status: row.status,
    process_status: row.process_status || "running",
    decision: row.decision || null,
    failure_kind: row.failure_kind || null,
    summary: row.summary || null,
    details: row.details || null,
    artifact_summary: safeJson(row.artifact_summary_json, {}),
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
  };
}

function compactChildTaskSummary(db, row) {
  return {
    ...compactTaskSummary(row),
    edge_type: row.edge_type,
    required: row.edge_required !== 0,
    last_run: latestTaskRunSummary(db, row.id),
  };
}

function parseEvents(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// §9.3 derived fields.
// `running_run_id` — latest task_runs row where status='running', or null.
// `last_run` — latest completed run summary (id, status, ended_at) for §5.3
//              error-chip policy.
function attachDerivedRunFields(db, task) {
  if (!task) return task;
  const runningRow = getRunningTaskRun(db, task.id);
  const runningLog = runningRow
    ? getAgentLogEvents(db, runningRow.id)
    : null;
  const runningEvents = runningLog ? parseEvents(runningLog.events) : [];
  const lastRow = getLastNonRunningTaskRun(db, task.id);
  return {
    ...task,
    running_run_id: runningRow?.id || null,
    running_run: runningRow ? {
      id: runningRow.id,
      status: runningRow.status,
      process_status: runningRow.process_status || "running",
      started_at: runningRow.started_at,
      event_count: runningEvents.length,
      last_event: runningEvents[runningEvents.length - 1] || null,
    } : null,
    last_run: lastRow ? {
      id: lastRow.id,
      status: lastRow.status,
      process_status: lastRow.process_status || "running",
      failure_kind: lastRow.failure_kind || null,
      ended_at: lastRow.ended_at,
      stage: lastRow.stage || (lastRow.mode === "review" ? "review" : "execute"),
      decision: lastRow.decision || null,
      summary: lastRow.summary || null,
    } : null,
  };
}

function attachTaskGraph(db, task) {
  if (!task) return task;
  const dependencyRows = listDirectDependencyRows(db, task.id);
  const dependentRows = listDirectDependentRows(db, task.id);
  const childRows = listSubtaskChildrenForParent(db, task.id);
  const parentRow = task.parent_task_id
    ? getTaskById(db, task.parent_task_id)
    : null;
  return {
    ...task,
    dependency_ids: dependencyRows.map((row) => row.id),
    blocked_by: dependencyRows.map(compactTaskSummary),
    blocks: dependentRows.map(compactTaskSummary),
    parent: compactTaskSummary(parentRow),
    children: childRows.map((row) => compactChildTaskSummary(db, row)),
  };
}

function attachAutomationSummary(db, task) {
  if (!task) return task;
  const rows = listAutomationSummaryForTask(db, task.id);
  const enabled = rows.filter((row) => row.enabled !== 0);
  const nextFireAt = enabled
    .map((row) => row.next_fire_at)
    .filter((value) => value != null)
    .sort((a, b) => a - b)[0] || null;
  const latestTrigger = getLatestAutomationTriggerForTask(db, task.id) || null;
  return {
    ...task,
    automation_summary: {
      count: rows.length,
      enabled_count: enabled.length,
      paused_count: rows.length - enabled.length,
      next_fire_at: nextFireAt,
      last_trigger: latestTrigger,
    },
  };
}

function attachProject(db, task, config = null) {
  if (!task) return task;
  const projectRow = task.project_id ? resolveProjectRow(db, task.project_id) : null;
  const project = compactProject(projectRow);
  return {
    ...task,
    project,
    effective_workdir: project?.workdir || config?.workspace || null,
  };
}

function enrichTask(db, task, config = null) {
  return attachProject(db, attachAutomationSummary(db, attachTaskGraph(db, attachDerivedRunFields(db, task))), config);
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

function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function firstRowsByTask(rows, taskKey = "task_id") {
  const byTask = new Map();
  for (const row of rows) {
    const taskId = row[taskKey];
    if (taskId && !byTask.has(taskId)) byTask.set(taskId, row);
  }
  return byTask;
}

function pushMapped(map, key, value) {
  if (!key) return;
  const list = map.get(key) || [];
  list.push(value);
  map.set(key, list);
}

function enrichTaskList(db, tasks, config = null) {
  if (!tasks.length) return [];
  const taskIds = tasks.map((task) => task.id);
  const output = tasks.map((task) => ({
    ...task,
    dependency_ids: [],
    blocked_by: [],
    blocks: [],
    parent: null,
    children: [],
    running_run_id: null,
    running_run: null,
    last_run: null,
    automation_summary: defaultAutomationSummary(),
    project: null,
    effective_workdir: config?.workspace || null,
  }));
  const byId = new Map(output.map((task) => [task.id, task]));

  const runningRows = firstRowsByTask(listRunningRunsWithEventsForTasks(db, taskIds));
  for (const [taskId, row] of runningRows.entries()) {
    const task = byId.get(taskId);
    if (!task) continue;
    task.running_run_id = row.id;
    task.running_run = {
      id: row.id,
      status: row.status,
      process_status: row.process_status || "running",
      started_at: row.started_at,
      event_count: Number(row.event_count || 0),
      last_event: safeJson(row.last_event_json, null),
    };
  }

  const lastRows = firstRowsByTask(listLastNonRunningRunsForTasks(db, taskIds));
  for (const [taskId, row] of lastRows.entries()) {
    const task = byId.get(taskId);
    if (!task) continue;
    task.last_run = {
      id: row.id,
      status: row.status,
      process_status: row.process_status || "running",
      failure_kind: row.failure_kind || null,
      ended_at: row.ended_at,
      stage: row.stage || (row.mode === "review" ? "review" : "execute"),
      decision: row.decision || null,
      summary: row.summary || null,
    };
  }

  const blockedBy = new Map();
  for (const row of listBlockedByForTasks(db, taskIds)) {
    pushMapped(blockedBy, row.owner_task_id, compactTaskSummary(row));
  }
  const blocks = new Map();
  for (const row of listBlocksForTasks(db, taskIds)) {
    pushMapped(blocks, row.owner_task_id, compactTaskSummary(row));
  }
  const children = new Map();
  for (const row of listSubtaskChildrenForParents(db, taskIds)) {
    pushMapped(children, row.owner_task_id, compactChildTaskSummary(db, row));
  }

  const parentIds = [...new Set(output.map((task) => task.parent_task_id).filter(Boolean))];
  const parents = new Map();
  for (const row of listTasksByIds(db, parentIds)) {
    parents.set(row.id, compactTaskSummary(row));
  }
  for (const task of output) {
    task.dependency_ids = (blockedBy.get(task.id) || []).map((row) => row.id);
    task.blocked_by = blockedBy.get(task.id) || [];
    task.blocks = blocks.get(task.id) || [];
    task.children = children.get(task.id) || [];
    task.parent = parents.get(task.parent_task_id) || null;
  }

  const automationSummaries = new Map(output.map((task) => [task.id, defaultAutomationSummary()]));
  for (const row of listAutomationSummariesForTasks(db, taskIds)) {
    const summary = automationSummaries.get(row.task_id);
    if (!summary) continue;
    summary.count += 1;
    if (row.enabled !== 0) {
      summary.enabled_count += 1;
      if (row.next_fire_at != null && (summary.next_fire_at == null || row.next_fire_at < summary.next_fire_at)) {
        summary.next_fire_at = row.next_fire_at;
      }
    } else {
      summary.paused_count += 1;
    }
  }
  const latestTriggers = firstRowsByTask(listLatestAutomationTriggersForTasks(db, taskIds));
  for (const [taskId, trigger] of latestTriggers.entries()) {
    const summary = automationSummaries.get(taskId);
    if (summary) summary.last_trigger = trigger;
  }
  for (const task of output) task.automation_summary = automationSummaries.get(task.id) || defaultAutomationSummary();

  const projectIds = [...new Set(output.map((task) => task.project_id).filter(Boolean))];
  const projects = new Map();
  for (const row of listProjectsByIds(db, projectIds)) {
    projects.set(row.id, compactProject(row));
  }
  for (const task of output) {
    task.project = projects.get(task.project_id) || null;
    task.effective_workdir = task.project?.workdir || config?.workspace || null;
  }

  return output;
}

function normaliseDependencyIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string" && entry.trim().length > 0))];
}

function normaliseClientRequestId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 160);
}

function normalizeRunPolicy(value, fallback = DEFAULT_RUN_POLICY) {
  if (value === undefined) return fallback;
  if (RUN_POLICIES.includes(value)) return value;
  throw Object.assign(new Error(`invalid run_policy: ${value}`), { code: "validation" });
}

function pathExists(db, startId, targetId, seen = new Set()) {
  if (startId === targetId) return true;
  if (seen.has(startId)) return false;
  seen.add(startId);
  for (const row of listDependsOnTaskIds(db, startId)) {
    if (pathExists(db, row.depends_on_task_id, targetId, seen)) return true;
  }
  return false;
}

function validateDependencyIds(db, taskId, dependencyIds) {
  const ids = normaliseDependencyIds(dependencyIds);
  const resolvedIds = [];
  for (const inputId of ids) {
    const dependencyId = resolveTaskId(db, inputId);
    if (!dependencyId) {
      throw Object.assign(new Error(`dependency task not found: ${inputId}`), { code: "validation" });
    }
    if (taskId && dependencyId === taskId) {
      throw Object.assign(new Error("a task cannot depend on itself"), { code: "validation" });
    }
    if (taskId && pathExists(db, dependencyId, taskId)) {
      throw Object.assign(new Error("dependency would create a cycle"), { code: "validation" });
    }
    resolvedIds.push(dependencyId);
  }
  return [...new Set(resolvedIds)];
}

function normalizeProjectPatchValue(db, value) {
  if (value === "__none__" || value === "none") return null;
  return resolveProjectId(db, value);
}

function cascadeProjectToEligibleDescendants(db, taskId, previousProjectId, nextProjectId, now) {
  return cascadeProjectToDescendants(db, {
    taskId,
    previousProjectId,
    nextProjectId,
    updatedAt: now,
  });
}

function replaceTaskDependencies(db, taskId, dependencyIds) {
  replaceDependenciesForTask(db, taskId, dependencyIds, Date.now());
}

function applyRouteSideEffects(db, broker, logger, taskId, sideEffects, currentStage, newStage) {
  const tx = db.transaction(() => {
    applyTaskSideEffects(db, taskId, sideEffects, currentStage, newStage, { logger });
  });
  tx();
  const taskKey = getTaskKeyById(db, taskId);
  broker.broadcast("global", { type: "task_updated", id: taskId, taskKey });
}

function nullableAgentName(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeParseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function rowToRun(row) {
  if (!row) return null;
  const {
    log_id,
    log_model,
    log_effort,
    log_input_tokens,
    log_output_tokens,
    log_cache_read_tokens,
    log_cache_creation_tokens,
    log_cost_usd,
    log_duration_ms,
    log_num_turns,
    log_status,
    warnings_json,
    diagnostics_json,
    artifacts_json,
    artifact_summary_json,
    ...run
  } = row;
  const hasLog = Boolean(log_id);
  const artifacts = artifactsForRunRow({ ...run, artifacts_json, artifact_summary_json });
  return {
    ...run,
    process_status: run.process_status || "running",
    stage: run.stage || (run.mode === "review" ? "review" : "execute"),
    artifact_paths: artifactPaths(artifacts),
    artifacts,
    artifact_summary: safeParseJson(artifact_summary_json, null) || runArtifactSummary(artifacts),
    result: run.result_json ? JSON.parse(run.result_json) : null,
    warnings: safeParseJson(warnings_json, []),
    diagnostics: safeParseJson(diagnostics_json, null),
    cost_usd: run.cost_usd ?? log_cost_usd ?? null,
    log: hasLog ? {
      id: log_id,
      model: log_model,
      effort: log_effort,
      input_tokens: log_input_tokens,
      output_tokens: log_output_tokens,
      cache_read_tokens: log_cache_read_tokens,
      cache_creation_tokens: log_cache_creation_tokens,
      cost_usd: log_cost_usd,
      duration_ms: log_duration_ms,
      num_turns: log_num_turns,
      status: log_status,
    } : null,
  };
}

function liveInputForRun(run, watcher) {
  const supported = supportsLiveInputProvider(run?.provider_kind);
  const state = watcher?.getRunLiveInputState?.(run.id) || null;
  return {
    supported,
    active: !!(supported && state?.active),
    reason: supported ? (state?.reason || null) : "unsupported_provider",
  };
}

function attachLiveInputState(runs, watcher) {
  return (runs || []).map((run) => ({
    ...run,
    live_input: liveInputForRun(run, watcher),
  }));
}

function selectRunsWithLog(db, whereClause, ...params) {
  return selectRunsWithLogJoin(db, whereClause, ...params).map(rowToRun);
}

function routeError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function sendRouteError(res, error) {
  if (!error?.status) throw error;
  return res.status(error.status).json({
    error: { code: error.code || "error", message: error.message },
  });
}

function rerunResponseError(error, fallbackCode = "invalid_state") {
  return {
    requested: true,
    started: false,
    error: {
      code: error?.code || fallbackCode,
      message: error?.message || "rerun failed",
    },
  };
}

function latestRetryStage(db, taskId, fallback = "execute") {
  const row = getLatestRetryStageRow(db, taskId);
  const stage = row?.retry_stage || row?.stage || fallback;
  return RUNNABLE_STAGES.includes(stage) ? stage : fallback;
}

async function requestCommentRerun({ db, broker, watcher, logger, taskId }) {
  if (!watcher?.handleRunRequested) {
    return rerunResponseError({ code: "not_configured", message: "watcher not wired" });
  }

  const runningRow = getRunningRunIdForTask(db, taskId);
  if (watcher.isActive?.(taskId) || runningRow) {
    return rerunResponseError({ code: "already_running", message: "task already running" });
  }

  try {
    const task = getTaskById(db, taskId);
    if (!task) return rerunResponseError({ code: "not_found", message: "task not found" }, "not_found");

    const currentStage = taskStage(task);
    if (!["plan", "execute", "review"].includes(currentStage)) {
      const result = nextStage(currentStage, { type: "human_move", target: "execute" });
      const errorSideEffect = result.sideEffects.find((se) => se.type === "error");
      if (errorSideEffect) {
        return rerunResponseError({ code: "invalid_transition", message: errorSideEffect.message });
      }
      applyRouteSideEffects(db, broker, logger, taskId, result.sideEffects, currentStage, result.stage);
    }

    const result = await watcher.handleRunRequested(taskId);
    return { requested: true, started: true, runId: result?.runId || null };
  } catch (error) {
    return rerunResponseError(error);
  }
}

function applyTaskPatchById({ db, broker, watcher, logger, taskId, patch = {}, config = null }) {
  const existing = getTaskById(db, taskId);
  if (!existing) throw routeError(404, "not_found", "task not found");
  if ("executor_agent" in (patch || {})) {
    throw routeError(400, "validation", "executor_agent is not supported; use owner_agent");
  }
  if ("status" in (patch || {})) {
    throw routeError(400, "validation", "status is not supported; use stage");
  }

  const fields = [];
  const values = [];
  let stageTransition = null;

  // Non-status fields
  for (const k of PATCHABLE) {
    if (k in patch) {
      fields.push(`${k} = ?`);
      if (k === "tags") values.push(JSON.stringify(patch[k] ?? []));
      else if (k === "project_id") {
        try {
          values.push(normalizeProjectPatchValue(db, patch[k]));
        } catch (error) {
          throw routeError(error.status || 400, error.code || "validation", error.message);
        }
      }
      else if (k === "run_policy") {
        try {
          values.push(normalizeRunPolicy(patch[k], existing.run_policy || DEFAULT_RUN_POLICY));
        } catch (error) {
          throw routeError(400, error.code || "validation", error.message);
        }
      } else values.push(patch[k]);
    }
  }

  if ("plan_body" in patch) {
    if (patch.plan_body != null && typeof patch.plan_body !== "string") {
      throw routeError(400, "validation", "plan_body must be a string");
    }
    const now = Date.now();
    fields.push("plan_body = ?");
    values.push(patch.plan_body || "");
    fields.push("plan_updated_at = ?");
    values.push(now);
    fields.push("plan_updated_by = ?");
    values.push("human");
    fields.push("plan_source_run_id = ?");
    values.push(null);
  }

  if ("stage" in patch) {
    const requested = patch.stage;
    if (!STAGES.includes(requested)) {
      throw routeError(400, "validation", "invalid stage");
    }
    const currentStage = taskStage(existing);
    const result = nextStage(currentStage, { type: "human_move", target: requested });
    const errorSideEffect = result.sideEffects.find((se) => se.type === "error");
    if (errorSideEffect) {
      throw routeError(400, "invalid_transition", errorSideEffect.message);
    }
    stageTransition = { currentStage, result };
  }

  if ("blocked_by_ids" in patch) {
    try {
      const dependencyIds = validateDependencyIds(db, taskId, patch.blocked_by_ids);
      replaceTaskDependencies(db, taskId, dependencyIds);
    } catch (error) {
      throw routeError(400, error.code || "validation", error.message);
    }
    fields.push("updated_at = ?");
    values.push(Date.now());
  }

  if (fields.length === 0 && !stageTransition) {
    return enrichTask(db, rowToTask(existing), config);
  }

  let projectCascadeCount = 0;
  if (fields.length > 0) {
    const projectIdChanged = "project_id" in patch;
    const nextProjectId = projectIdChanged ? normalizeProjectPatchValue(db, patch.project_id) : null;
    const updatedAt = Date.now();
    if (!fields.includes("updated_at = ?")) {
      fields.push("updated_at = ?");
      values.push(updatedAt);
    }
    values.push(taskId);
    db.transaction(() => {
      updateTaskFields(db, fields, values);
      if (projectIdChanged && nextProjectId !== (existing.project_id || null)) {
        projectCascadeCount = cascadeProjectToEligibleDescendants(
          db,
          taskId,
          existing.project_id || null,
          nextProjectId,
          updatedAt,
        );
      }
    })();
    broker?.broadcast?.("global", { type: "task_updated", id: taskId, taskKey: existing.task_key || null });
  }

  if (stageTransition) {
    applyRouteSideEffects(
      db,
      broker,
      logger,
      taskId,
      stageTransition.result.sideEffects,
      stageTransition.currentStage,
      stageTransition.result.stage,
    );
    if (stageTransition.result.stage === "done" || stageTransition.result.stage === "blocked") {
      resumeWaitingParents({
        db,
        childTaskId: taskId,
        applySideEffects: (parentTaskId, sideEffects, currentStage, newStage) => {
          applyRouteSideEffects(db, broker, logger, parentTaskId, sideEffects, currentStage, newStage);
        },
      });
    }
    if (stageTransition.result.stage === "done") {
      watcher?.maybeAutoStartDependents?.(taskId);
    }
  }
  watcher?.maybeAutoStart?.(taskId);

  const row = getTaskById(db, taskId);
  const enriched = enrichTask(db, rowToTask(row), config);
  if (projectCascadeCount > 0) enriched.cascade = { project_id_descendants: projectCascadeCount };
  return enriched;
}

function deleteTaskById({ db, broker, watcher, taskId }) {
  const existingTaskKey = getTaskKeyById(db, taskId);
  if (taskHasRunningRun(db, taskId) || watcher?.isActive?.(taskId)) {
    throw routeError(409, "task_running", "cancel the active run before deleting this task");
  }
  const r = deleteTaskByIdRow(db, taskId);
  if (r.changes === 0) throw routeError(404, "not_found", "task not found");
  broker?.broadcast?.("global", { type: "task_deleted", id: taskId, taskKey: existingTaskKey });
}

function normalizeBulkIds(value) {
  if (!Array.isArray(value)) {
    throw routeError(400, "validation", "ids must be an array");
  }
  const ids = [...new Set(value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
  if (ids.length === 0) {
    throw routeError(400, "validation", "ids are required");
  }
  return ids;
}

function validateBulkPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw routeError(400, "validation", "patch is required");
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw routeError(400, "validation", "patch is required");
  }
  for (const key of keys) {
    if (!BULK_PATCHABLE.includes(key)) {
      throw routeError(400, "validation", `unsupported bulk patch field: ${key}`);
    }
  }
  if ("stage" in patch && !STAGES.includes(patch.stage)) {
    throw routeError(400, "validation", "invalid stage");
  }
  if ("run_policy" in patch) {
    try {
      normalizeRunPolicy(patch.run_policy);
    } catch (error) {
      throw routeError(400, error.code || "validation", error.message);
    }
  }
}

function bulkSummary(results) {
  const succeeded = results.filter((result) => result.ok).length;
  return {
    requested: results.length,
    succeeded,
    failed: results.length - succeeded,
  };
}

function resultError(error) {
  return {
    code: error.code || "error",
    message: error.message || "failed",
    status: error.status || 500,
  };
}

function taskOr404(db, value) {
  const task = resolveTaskRow(db, value);
  if (!task) throw routeError(404, "not_found", "task not found");
  return task;
}

export function registerTaskRoutes(app, { db, broker, watcher, logger, dataDir, repoRoot, config }) {
  app.get("/api/runs/cost-summary", (req, res) => {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const weekStart = todayStart.getTime() - 6 * 24 * 60 * 60 * 1000;
    const today = getCostSummarySince(db, todayStart.getTime());
    const week = getCostSummarySince(db, weekStart);
    const byAgent = getCostSummaryByAgentSince(db, todayStart.getTime());
    res.json({
      today: { total_usd: Number(today.total || 0), run_count: today.runs },
      week: { total_usd: Number(week.total || 0), run_count: week.runs },
      today_by_agent: byAgent.map((row) => ({ agent: row.agent_name, total_usd: Number(row.total || 0), run_count: row.runs })),
    });
  });

  app.get("/api/tasks", (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      return res.status(400).json({
        error: { code: "validation", message: "status is not supported; use stage" },
      });
    }
    if (req.query.stage) {
      if (!STAGES.includes(req.query.stage)) {
        return res.status(400).json({ error: { code: "validation", message: `invalid stage: ${req.query.stage}` } });
      }
      where.push("stage = ?");
      params.push(req.query.stage);
    }
    if (req.query.agent) {
      where.push("(owner_agent = ? OR planner_agent = ? OR reviewer_agent = ?)");
      params.push(req.query.agent, req.query.agent, req.query.agent);
    }
    const projectFilter = req.query.project_id || req.query.project;
    if (projectFilter) {
      if (projectFilter === "none" || projectFilter === "__none__") {
        where.push("project_id IS NULL");
      } else {
        try {
          where.push("project_id = ?");
          params.push(resolveProjectId(db, projectFilter));
        } catch (error) {
          return sendRouteError(res, error);
        }
      }
    }
    const view = String(req.query.view || "full");
    if (!["full", "summary"].includes(view)) {
      return res.status(400).json({ error: { code: "validation", message: "invalid view" } });
    }
    const rows = listFilteredTasks(db, { filters: where, params });
    const baseTasks = rows.map(rowToTask);
    const tasks = view === "summary" ? baseTasks : enrichTaskList(db, baseTasks, config);
    res.json({ tasks });
  });

  app.post("/api/tasks", (req, res) => {
    if ("executor_agent" in (req.body || {})) {
      return res.status(400).json({
        error: { code: "validation", message: "executor_agent is not supported; use owner_agent" },
      });
    }
    if ("status" in (req.body || {})) {
      return res.status(400).json({
        error: { code: "validation", message: "status is not supported; use stage" },
      });
    }
    const {
      title,
      instructions = "",
      reviewer_agent = null,
      owner_agent = null,
      planner_agent = null,
      stage = "plan",
      run_policy = DEFAULT_RUN_POLICY,
      tags = [],
      blocked_by_ids = [],
      client_request_id = null,
      project_id = null,
    } = req.body || {};
    const requestId = normaliseClientRequestId(client_request_id);
    if (requestId) {
      const existing = getTaskByClientRequestId(db, requestId);
      if (existing) return res.status(200).json({ task: enrichTask(db, rowToTask(existing), config) });
    }
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "title is required" } });
    }
    if (!STAGES.includes(stage)) {
      return res.status(400).json({ error: { code: "validation", message: `invalid stage: ${stage}` } });
    }
    let normalizedRunPolicy = DEFAULT_RUN_POLICY;
    try {
      normalizedRunPolicy = normalizeRunPolicy(run_policy);
    } catch (error) {
      return res.status(400).json({ error: { code: error.code || "validation", message: error.message } });
    }
    let dependencyIds = [];
    let projectId = null;
    try {
      dependencyIds = validateDependencyIds(db, null, blocked_by_ids);
      projectId = normalizeProjectPatchValue(db, project_id);
    } catch (error) {
      return res.status(400).json({ error: { code: error.code || "validation", message: error.message } });
    }
    const now = Date.now();
    let id;
    try {
      db.transaction(() => {
        id = newTaskId();
        insertTask(db, {
          id,
          taskKey: nextTaskKey(db),
          projectId,
          rootTaskId: id,
          clientRequestId: requestId,
          title,
          instructions,
          stage,
          ownerAgent: owner_agent,
          plannerAgent: planner_agent,
          reviewerAgent: reviewer_agent,
          runPolicy: normalizedRunPolicy,
          tagsJson: JSON.stringify(tags),
          createdAt: now,
          updatedAt: now,
        });
        replaceTaskDependencies(db, id, dependencyIds);
      })();
    } catch (error) {
      if (requestId && String(error?.code || "").includes("SQLITE_CONSTRAINT")) {
        const existing = getTaskByClientRequestId(db, requestId);
        if (existing) return res.status(200).json({ task: enrichTask(db, rowToTask(existing), config) });
      }
      throw error;
    }
    const row = getTaskById(db, id);
    const task = enrichTask(db, rowToTask(row), config);
    broker.broadcast("global", { type: "task_created", id, taskKey: task.task_key || null });
    watcher?.maybeAutoStart?.(id);
    res.status(201).json({ task });
  });

  app.post("/api/tasks/bulk", async (req, res) => {
    let ids;
    try {
      ids = normalizeBulkIds(req.body?.ids);
      const operation = req.body?.operation;
      if (!["patch", "delete", "run"].includes(operation)) {
        throw routeError(400, "validation", "operation must be patch, delete, or run");
      }
      if (operation === "patch") validateBulkPatch(req.body?.patch);
      if (operation === "run" && !watcher?.handleRunRequested) {
        throw routeError(501, "not_configured", "watcher not wired");
      }

      const results = [];
      for (const inputId of ids) {
        try {
          const taskRow = taskOr404(db, inputId);
          if (operation === "delete") {
            deleteTaskById({ db, broker, watcher, taskId: taskRow.id });
            results.push({ id: inputId, task_id: taskRow.id, ok: true });
            continue;
          }
          if (operation === "run") {
            const run = await watcher.handleRunRequested(taskRow.id);
            results.push({ id: inputId, task_id: taskRow.id, ok: true, runId: run?.runId || null });
            continue;
          }
          const task = applyTaskPatchById({
            db,
            broker,
            watcher,
            logger,
            taskId: taskRow.id,
            patch: req.body.patch,
            config,
          });
          results.push({ id: inputId, task_id: taskRow.id, ok: true, task });
        } catch (error) {
          const normalizedError = operation === "run" && !error.status
            ? Object.assign(error, { status: 400, code: error.code || "invalid_state" })
            : error;
          results.push({ id: inputId, ok: false, error: resultError(normalizedError) });
        }
      }

      res.json({ summary: bulkSummary(results), results });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.get("/api/tasks/:id", (req, res) => {
    const row = resolveTaskRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const comments = enrichCommentRows(db, listTaskComments(db, row.id));
    const runs = attachLiveInputState(selectRunsWithLog(db, "WHERE r.task_id = ?", row.id), watcher);
    const task = enrichTask(db, rowToTask(row), config);
    const taskArtifacts = loadTaskArtifacts(db, row.id);
    task.artifacts = taskArtifacts.artifacts;
    task.artifact_summary = taskArtifacts.summary;
    // §9.3 is_locked: derived from coordinator.active.has(taskId). Null when
    // the watcher isn't wired so the UI can't falsely flag a stuck task.
    task.is_locked = watcher?.isActive ? !!watcher.isActive(row.id) : null;
    res.json({ task, comments, runs });
  });

  app.patch("/api/tasks/:id", (req, res) => {
    try {
      const taskRow = taskOr404(db, req.params.id);
      const task = applyTaskPatchById({
        db,
        broker,
        watcher,
        logger,
        taskId: taskRow.id,
        patch: req.body || {},
        config,
      });
      res.json({ task });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.post("/api/tasks/:id/subtasks", (req, res) => {
    const parent = resolveTaskRow(db, req.params.id);
    if (!parent) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });

    const body = req.body || {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return res.status(400).json({ error: { code: "validation", message: "title is required" } });
    }
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    const ownerAgent = nullableAgentName(body.owner_agent, parent.owner_agent || null);
    const plannerAgent = nullableAgentName(body.planner_agent, parent.planner_agent || null);
    const reviewerAgent = nullableAgentName(body.reviewer_agent, parent.reviewer_agent || null);
    const required = body.required === false ? 0 : 1;
    const now = Date.now();
    const childId = newTaskId();
    const rootTaskId = parent.root_task_id || parent.id;
    const subtaskOrder = Number(getMaxSubtaskOrder(db, parent.id)) + 1;
    const shouldWait = required === 1 && !["done", "blocked"].includes(taskStage(parent));

    try {
      db.transaction(() => {
        insertManualSubtask(db, {
          id: childId,
          taskKey: nextTaskKey(db),
          rootTaskId,
          parentTaskId: parent.id,
          ownerAgent,
          plannerAgent,
          reviewerAgent,
          projectId: parent.project_id || null,
          title,
          instructions,
          runPolicy: parent.run_policy || DEFAULT_RUN_POLICY,
          subtaskOrder,
          required,
          tagsJson: JSON.stringify([]),
          createdAt: now,
          updatedAt: now,
        });
        insertSubtaskEdge(db, {
          parentTaskId: parent.id,
          childTaskId: childId,
          required,
          createdByRunId: null,
          createdAt: now,
        });
        if (shouldWait) {
          markParentAwaitingChildren(db, parent.id, now);
        } else {
          touchTaskUpdatedAt(db, parent.id, now);
        }
      })();
    } catch (error) {
      if (String(error?.code || "").includes("SQLITE_CONSTRAINT")) {
        return res.status(400).json({ error: { code: "validation", message: error.message } });
      }
      throw error;
    }

    const child = enrichTask(db, rowToTask(getTaskById(db, childId)), config);
    const updatedParent = enrichTask(db, rowToTask(getTaskById(db, parent.id)), config);
    broker.broadcast("global", { type: "task_created", id: childId, taskKey: child.task_key || null });
    broker.broadcast("global", { type: "task_updated", id: parent.id, taskKey: updatedParent.task_key || null });
    watcher?.maybeAutoStart?.(childId);
    res.status(201).json({ task: child, parent: updatedParent });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    try {
      const taskRow = taskOr404(db, req.params.id);
      deleteTaskById({ db, broker, watcher, taskId: taskRow.id });
      res.status(204).end();
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.post("/api/tasks/:id/comments", async (req, res) => {
    const existing = resolveTaskRow(db, req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const { body, rerun } = req.body || {};
    if (!body || typeof body !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "body is required" } });
    }
    const id = newCommentId();
    const now = Date.now();
    insertAuthoredComment(db, {
      id,
      taskId: existing.id,
      authorType: "human",
      authorId: null,
      body,
      createdAt: now,
    });
    touchTaskUpdatedAt(db, existing.id, now);
    broker.broadcast("global", { type: "task_updated", id: existing.id, taskKey: existing.task_key || null });
    const row = enrichCommentRows(db, [getCommentById(db, id)])[0];
    const payload = { comment: row };
    if (rerun === true) {
      payload.rerun = await requestCommentRerun({ db, broker, watcher, logger, taskId: existing.id });
    }
    res.status(201).json(payload);
  });

  app.delete("/api/tasks/:id/comments/:commentId", (req, res) => {
    try {
      const existing = taskOr404(db, req.params.id);
      const requestedCommentId = String(req.params.commentId || "");
      let comment = getTaskCommentById(db, requestedCommentId, existing.id);
      if (!comment && requestedCommentId.startsWith("c-")) {
        comment = getTaskCommentById(db, requestedCommentId.slice(2), existing.id);
      }
      if (!comment) throw routeError(404, "not_found", "comment not found");
      if (comment.author_type !== "human") {
        throw routeError(403, "forbidden", "only human comments can be deleted");
      }
      const now = Date.now();
      db.transaction(() => {
        deleteCommentByIdAndTaskId(db, comment.id, existing.id);
        touchTaskUpdatedAt(db, existing.id, now);
      })();
      broker.broadcast("global", { type: "task_updated", id: existing.id, taskKey: existing.task_key || null });
      res.status(204).end();
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.get("/api/tasks/:id/runs", (req, res) => {
    const existing = resolveTaskRow(db, req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const runs = attachLiveInputState(selectRunsWithLog(db, "WHERE r.task_id = ?", existing.id), watcher);
    res.json({ runs });
  });

  app.get("/api/tasks/:id/run-preview", (req, res) => {
    try {
      const taskRow = taskOr404(db, req.params.id);
      const preview = buildNextTaskRunPreview({
        db,
        taskId: taskRow.id,
        config: {
          ...(config || {}),
          dataDir: config?.dataDir || dataDir,
          repoRoot: config?.repoRoot || repoRoot,
        },
        worklabToolSurfaceMarkdown: WORKLAB_TOOL_SURFACE_MARKDOWN,
      });
      res.json({ preview });
    } catch (error) {
      if (error?.status) return sendRouteError(res, error);
      throw error;
    }
  });

  app.post("/api/tasks/:id/run", async (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    try {
      const taskRow = taskOr404(db, req.params.id);
      const result = await watcher.handleRunRequested(taskRow.id);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: { code: err.code || "invalid_state", message: err.message } });
    }
  });

  app.post("/api/tasks/:id/retry", async (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    try {
      const taskRow = taskOr404(db, req.params.id);
      const currentStage = taskStage(taskRow);
      if (["blocked", "awaiting_user"].includes(currentStage)) {
        const targetStage = latestRetryStage(db, taskRow.id, "execute");
        const transition = nextStage(currentStage, { type: "human_move", target: targetStage, reason: "retry from API" });
        const errorSideEffect = transition.sideEffects.find((se) => se.type === "error");
        if (errorSideEffect) {
          return res.status(400).json({ error: { code: "invalid_transition", message: errorSideEffect.message } });
        }
        applyRouteSideEffects(db, broker, logger, taskRow.id, transition.sideEffects, currentStage, transition.stage);
      } else if (!["plan", "execute", "review"].includes(currentStage)) {
        return res.status(400).json({ error: { code: "invalid_state", message: `cannot retry from ${currentStage}` } });
      }
      const result = await watcher.handleRunRequested(taskRow.id);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: { code: err.code || "invalid_state", message: err.message } });
    }
  });

  app.post("/api/tasks/:id/cancel", (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    const taskRow = resolveTaskRow(db, req.params.id);
    if (!taskRow) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const taskId = taskRow.id;
    const reasonInput = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    const reason = reasonInput || null;
    const cancelled = watcher.cancel(taskId, { initiator: "api_cancel", reason });
    if (cancelled) return res.status(204).end();

    // No live worker — check for a stale `running` row left behind by a crashed
    // worker or coordinator restart. If found, reconcile so the UI can move on.
    const staleRun = getStaleRunningRunForTask(db, taskId);
    if (!staleRun) return res.status(404).json({ error: { code: "not_running", message: "no active run" } });

    const now = Date.now();
    db.transaction(() => {
      applyStaleRunReconcileToRun(db, {
        runId: staleRun.id,
        endedAt: now,
        errorText: "worker exited",
        reason: reason || "stale run reconciled by API cancel",
      });
      applyStaleRunReconcileToTask(db, {
        taskId,
        retryStage: staleRun.stage || "execute",
        errorTextFallback: "Previous run did not finish",
        updatedAt: now,
      });
    })();

    broker.broadcast("global", buildRunLifecycleEvent(db, "run_ended", staleRun.id, {
      taskId,
      taskKey: taskRow.task_key || null,
    }));
    broker.broadcast("global", { type: "task_updated", id: taskId, taskKey: taskRow.task_key || null });
    res.status(204).end();
  });
}
