import {
  artifactPaths,
  artifactsForRunRow,
  compactTeam,
  compactProject,
  loadTaskArtifacts,
  resolveProjectRow,
  runArtifactSummary,
  runTodoStateSummary,
  supportsLiveInputProvider,
  taskInstructionAttachments,
  collectGitDiffArtifactsForRun,
} from "../../../core/index.js";
import {
  getTaskById,
  listTaskSummaryRowsByIds,
} from "../../../core/db/queries/tasks.js";
import { getAgentLogEvents } from "../../../core/db/queries/agent-logs.js";
import {
  getLastNonRunningTaskRun,
  getLatestExecuteRunSummary,
  getLatestTaskRunSummary,
  getRunningTaskRun,
  listLastNonRunningRunSummariesForTasks,
  listLastNonRunningRunsForTasks,
  listRunningRunSummariesForTasks,
  listRunningRunsWithEventsForTasks,
  listTaskRunsWithLogJoin,
  selectRunsWithLogJoin,
} from "../../../core/db/queries/runs.js";
import {
  listBlockedByForTasks,
  listBlocksForTasks,
  listDirectDependencyRows,
  listDirectDependentRows,
} from "../../../core/db/queries/task-dependencies.js";
import {
  listSubtaskChildrenForParent,
  listSubtaskChildrenForParents,
} from "../../../core/db/queries/task-edges.js";
import {
  getLatestAutomationTriggerForTask,
  listAutomationSummariesForTasks,
  listAutomationSummaryForTask,
  listLatestAutomationTriggersForTasks,
} from "../../../core/db/queries/automations.js";
import { listProjectsByIds } from "../../../core/db/queries/projects.js";
import { listTeamsByIdsOrSlugs, resolveTeamByIdOrSlug } from "../../../core/db/queries/teams.js";
import { DEFAULT_RUN_POLICY } from "./constants.js";

function safeJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function rowToTask(row) {
  if (!row) return null;
  const stage = row.stage || "plan";
  const hasPlanBody = Object.prototype.hasOwnProperty.call(row, "plan_body");
  return {
    ...row,
    stage,
    tags: JSON.parse(row.tags || "[]"),
    failure_count: row.failure_count ?? 0,
    run_policy: row.run_policy || DEFAULT_RUN_POLICY,
    project_id: row.project_id || null,
    team_id: row.team_id || null,
    is_team_root: !!row.is_team_root,
    goal_status: row.goal_status || null,
    goal_status_reason: row.goal_status_reason || null,
    goal_contract: safeJsonObject(row.goal_contract_json),
    last_lead_at: row.last_lead_at || null,
    root_task_id: row.root_task_id || row.id,
    parent_task_id: row.parent_task_id || null,
    owner_agent: row.owner_agent || null,
    planner_agent: row.planner_agent || null,
    delegated_to_agent: row.delegated_to_agent || null,
    delegated_by_run_id: row.delegated_by_run_id || null,
    ...(hasPlanBody ? { plan_body: row.plan_body || "" } : {}),
    plan_updated_at: row.plan_updated_at || null,
    plan_updated_by: row.plan_updated_by || null,
    plan_source_run_id: row.plan_source_run_id || null,
    required: row.required !== 0,
    pending_actions: JSON.parse(row.pending_actions_json || "[]"),
    pending_questions: JSON.parse(row.pending_questions_json || "[]"),
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

function latestExecuteRunSummary(db, taskId) {
  const row = getLatestExecuteRunSummary(db, taskId);
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    stage: row.stage,
    agent_name: row.agent_name || null,
    status: row.status,
    process_status: row.process_status || row.status || null,
    decision: row.decision || null,
    failure_kind: row.failure_kind || null,
    summary: row.summary || null,
    details: row.details || null,
    artifact_summary: safeJson(row.artifact_summary_json, {}),
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
  };
}

function compactDependencySummary(db, row) {
  const summary = compactTaskSummary(row);
  if (!summary) return null;
  const artifacts = loadTaskArtifacts(db, summary.id, { artifactResolver: collectGitDiffArtifactsForRun });
  return {
    ...summary,
    latest_execute_run: latestExecuteRunSummary(db, summary.id),
    artifact_summary: artifacts.summary,
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

function isContinuationOfRun(runningRow, lastRow) {
  if (!runningRow || !lastRow?.id) return false;
  const runningDiagnostics = safeJson(runningRow.diagnostics_json, {});
  if (runningDiagnostics?.continuation_of_run_id === lastRow.id) return true;
  const lastDiagnostics = safeJson(lastRow.diagnostics_json, {});
  if (lastDiagnostics?.continuation_run_id === runningRow.id) return true;
  const runningMode = runningRow.mode || null;
  const lastMode = lastRow.mode || null;
  const runningStage = runningRow.stage || runningMode;
  const lastStage = lastRow.stage || lastMode;
  return Boolean(
    runningRow.parent_run_id === lastRow.id
    && (!runningMode || !lastMode || runningMode === lastMode)
    && (!runningStage || !lastStage || runningStage === lastStage)
  );
}

function compactRunRecovery(lastRow, runningRow) {
  if (!lastRow) return null;
  const lastDiagnostics = safeJson(lastRow.diagnostics_json, {});
  const runningDiagnostics = safeJson(runningRow?.diagnostics_json, {});
  const active = isContinuationOfRun(runningRow, lastRow);
  const retryable = lastDiagnostics?.retryable_provider_error === true
    || runningDiagnostics?.retryable_provider_error === true
    || lastDiagnostics?.continuation_scheduled === true
    || active;
  if (!retryable) return null;
  const depth = active
    ? runningDiagnostics?.continuation_depth
    : lastDiagnostics?.continuation_depth;
  const limit = runningDiagnostics?.continuation_limit ?? lastDiagnostics?.continuation_limit ?? null;
  return {
    retryable: true,
    subkind: lastDiagnostics?.provider_error_subkind || runningDiagnostics?.provider_error_subkind || null,
    active_run_id: active ? runningRow.id : null,
    continuation_of_run_id: active
      ? (runningDiagnostics?.continuation_of_run_id || lastRow.id)
      : (lastDiagnostics?.continuation_of_run_id || null),
    depth: Number.isFinite(Number(depth)) ? Number(depth) : null,
    limit: Number.isFinite(Number(limit)) ? Number(limit) : null,
    context_risk: lastDiagnostics?.context_risk || runningDiagnostics?.context_risk || null,
    stage: lastRow.stage || (lastRow.mode === "review" ? "review" : "execute"),
  };
}

function compactLastRun(row, runningRow = null, { includeRecovery = true } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    process_status: row.process_status || "running",
    failure_kind: row.failure_kind || null,
    ended_at: row.ended_at,
    stage: row.stage || (row.mode === "review" ? "review" : "execute"),
    decision: row.decision || null,
    summary: row.summary || null,
    recovery: includeRecovery ? compactRunRecovery(row, runningRow) : null,
  };
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
      todo_state: runTodoStateSummary(runningRow.todo_state_json),
    } : null,
    last_run: compactLastRun(lastRow, runningRow),
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
    blocked_by: dependencyRows.map((row) => compactDependencySummary(db, row)).filter(Boolean),
    blocks: dependentRows.map((row) => compactDependencySummary(db, row)).filter(Boolean),
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

function attachTeam(db, task) {
  if (!task) return task;
  const teamRow = task.team_id ? resolveTeamByIdOrSlug(db, task.team_id) : null;
  return {
    ...task,
    team: compactTeam(teamRow),
  };
}

function attachTaskAttachments(db, task) {
  if (!task) return task;
  return {
    ...task,
    attachments: taskInstructionAttachments(db, task.id),
  };
}

export function enrichTask(db, task, config = null) {
  return attachTaskAttachments(db, attachTeam(db, attachProject(db, attachAutomationSummary(db, attachTaskGraph(db, attachDerivedRunFields(db, task))), config)));
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

export function enrichTaskList(db, tasks, config = null, { compactRuns = false } = {}) {
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
    team: null,
    effective_workdir: config?.workspace || null,
  }));
  const byId = new Map(output.map((task) => [task.id, task]));

  const runningRows = firstRowsByTask(compactRuns
    ? listRunningRunSummariesForTasks(db, taskIds)
    : listRunningRunsWithEventsForTasks(db, taskIds));
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
      last_event: row.last_event_json ? safeJson(row.last_event_json, null) : null,
      todo_state: runTodoStateSummary(row.todo_state_json),
    };
  }

  const lastRows = firstRowsByTask(compactRuns
    ? listLastNonRunningRunSummariesForTasks(db, taskIds)
    : listLastNonRunningRunsForTasks(db, taskIds));
  for (const [taskId, row] of lastRows.entries()) {
    const task = byId.get(taskId);
    if (!task) continue;
    task.last_run = compactLastRun(row, runningRows.get(taskId) || null, { includeRecovery: !compactRuns });
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
  for (const row of listTaskSummaryRowsByIds(db, parentIds)) {
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

  const teamIds = [...new Set(output.map((task) => task.team_id).filter(Boolean))];
  const teams = new Map();
  for (const row of listTeamsByIdsOrSlugs(db, teamIds)) {
    const team = compactTeam(row);
    teams.set(row.id, team);
    teams.set(row.slug, team);
  }
  for (const task of output) {
    task.team = teams.get(task.team_id) || null;
  }

  return output;
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
    worktree_json,
    capabilities_used_json,
    failover_history_json,
    tool_usage_summary_json,
    ...run
  } = row;
  const hasLog = Boolean(log_id);
  const runRow = { ...run, artifacts_json, artifact_summary_json, worktree_json };
  const artifacts = artifactsForRunRow(runRow, {
    extraArtifacts: collectGitDiffArtifactsForRun(runRow),
  });
  const artifactSummary = artifacts.length
    ? runArtifactSummary(artifacts)
    : safeParseJson(artifact_summary_json, null) || runArtifactSummary(artifacts);
  const diagnostics = safeParseJson(diagnostics_json, null);
  return {
    ...run,
    parent_run_id: run.parent_run_id || null,
    process_status: run.process_status || "running",
    workspace_mode: run.workspace_mode || "direct",
    source_workdir: run.source_workdir || null,
    worktree: safeParseJson(worktree_json, null),
    stage: run.stage || (run.mode === "review" ? "review" : "execute"),
    artifact_paths: artifactPaths(artifacts),
    artifacts,
    artifact_summary: artifactSummary,
    result: run.result_json ? JSON.parse(run.result_json) : null,
    warnings: safeParseJson(warnings_json, []),
    diagnostics,
    error_details: (diagnostics && typeof diagnostics === "object" && diagnostics.error_details) || null,
    cost_usd: run.cost_usd ?? log_cost_usd ?? null,
    capabilities_used: safeParseJson(capabilities_used_json, null),
    failover_history: safeParseJson(failover_history_json, null),
    tool_usage_summary: safeParseJson(tool_usage_summary_json, null),
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

function rowToRunSummary(row) {
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
    artifact_summary_json,
    todo_state_json,
    worktree_json,
    ...run
  } = row;
  const hasLog = Boolean(log_id);
  return {
    ...run,
    parent_run_id: run.parent_run_id || null,
    process_status: run.process_status || "running",
    workspace_mode: run.workspace_mode || "direct",
    source_workdir: run.source_workdir || null,
    worktree: safeParseJson(worktree_json, null),
    stage: run.stage || (run.mode === "review" ? "review" : "execute"),
    artifact_summary: safeParseJson(artifact_summary_json, null) || {},
    todo_state: runTodoStateSummary(todo_state_json),
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

// Decorate runs with continuation lineage derived purely from the array.
// Walks `parent_run_id` ancestors within the array (no DB calls) so a single
// task-detail call doesn't N+1 the chain.
export function attachContinuationLinks(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return runs;
  const byId = new Map();
  for (const run of runs) {
    if (run?.id) byId.set(run.id, run);
  }
  const continuationParentId = (run) => {
    const diagnosticParentId = run?.diagnostics?.continuation_of_run_id || null;
    if (diagnosticParentId && byId.has(diagnosticParentId)) return diagnosticParentId;
    if (!run?.parent_run_id || !byId.has(run.parent_run_id)) return null;
    const parent = byId.get(run.parent_run_id);
    const runMode = run.mode || null;
    const parentMode = parent.mode || null;
    const runStage = run.stage || runMode;
    const parentStage = parent.stage || parentMode;
    if (runMode && parentMode && runMode !== parentMode) return null;
    if (runStage && parentStage && runStage !== parentStage) return null;
    return run.parent_run_id;
  };
  const continuationFor = new Map();
  for (const run of runs) {
    let depth = 0;
    let rootId = run.id;
    let cursorId = continuationParentId(run);
    let cursor = cursorId ? byId.get(cursorId) : null;
    const visited = new Set([run.id]);
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      depth += 1;
      rootId = cursor.id;
      cursorId = continuationParentId(cursor);
      cursor = cursorId ? byId.get(cursorId) : null;
    }
    continuationFor.set(run.id, { depth, root_run_id: rootId });
  }
  const childOf = new Map();
  for (const run of runs) {
    const parentId = continuationParentId(run);
    if (parentId) {
      if (!childOf.has(parentId)) childOf.set(parentId, run.id);
    }
  }
  return runs.map((run) => ({
    ...run,
    continuation: continuationFor.get(run.id) || { depth: 0, root_run_id: run.id },
    continuation_child_id: childOf.get(run.id) || null,
  }));
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

export function attachLiveInputState(runs, watcher) {
  return (runs || []).map((run) => ({
    ...run,
    live_input: liveInputForRun(run, watcher),
  }));
}

export function selectTaskRunsWithLog(db, taskId, { view = "full", limit = null, cursor = null } = {}) {
  const rows = listTaskRunsWithLogJoin(db, taskId, { view, limit, cursor });
  return rows.map(view === "summary" ? rowToRunSummary : rowToRun);
}
