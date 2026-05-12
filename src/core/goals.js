import {
  getLeadCycleByRunId,
  insertLeadCycle,
  listDueLeadCycleFollowups as listDueLeadCycleFollowupRows,
  listLeadCyclesByGoal,
  listMatchingLeadCycleEventFollowups as listMatchingLeadCycleEventFollowupRows,
  markLeadCycleReviewConsumed,
  updateLeadCycleByRunId,
} from "./db/queries/goals.js";

export {
  appendTeamGoalCheckpoint,
  getTeamProjectGoal,
  getTeamProjectGoalById,
  goalContractReadiness,
  leadCycleBlockedByGoal,
  listTeamProjectGoals,
  normalizeTeamGoalContract,
  safeParseTeamGoalContract,
  serializeTeamGoalContract,
  teamProjectGoalFromRows,
  updateTeamProjectGoal,
} from "./teams.js";

function safeJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function jsonArray(value) {
  const parsed = safeJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function jsonObject(value) {
  const parsed = safeJson(value, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function normalizeReviewHint(value) {
  const hint = jsonObject(value);
  const afterMinutes = Number(hint.after_minutes);
  const event = String(hint.after_event || "").trim();
  return {
    after_minutes: Number.isInteger(afterMinutes) && afterMinutes > 0 ? afterMinutes : null,
    after_event: event || null,
  };
}

function nextReviewDueAt(hint, endedAt) {
  if (!hint?.after_minutes) return null;
  const base = Number(endedAt);
  if (!Number.isFinite(base) || base <= 0) return null;
  return base + hint.after_minutes * 60 * 1000;
}

function ensureLeadCycleForRun(db, runId) {
  if (!runId) return null;
  const existing = getLeadCycleByRunId(db, runId);
  if (existing) return existing;
  const run = db.prepare(`
    SELECT r.*, t.team_id AS task_team_id, t.project_id AS task_project_id, g.id AS goal_id
    FROM task_runs r
    LEFT JOIN tasks t ON t.id = r.task_id
    LEFT JOIN goals g ON g.root_task_id = r.task_id
    WHERE r.id = ?
  `).get(runId);
  if (!run) return null;
  return insertLeadCycle(db, {
    id: runId,
    runId,
    goalId: run.goal_id || null,
    taskId: run.task_id || null,
    teamId: run.team_id || run.task_team_id || null,
    projectId: run.project_id || run.task_project_id || null,
    reason: jsonObject(run.diagnostics_json).lead_cycle_reason || "manual",
    processStatus: run.process_status || "running",
    status: run.status || "running",
    startedAt: run.started_at || Date.now(),
    createdAt: run.started_at || Date.now(),
    updatedAt: Date.now(),
  });
}

export function leadCycleFromRow(row) {
  if (!row) return null;
  const nextReviewHint = jsonObject(row.next_review_hint_json);
  return {
    id: row.id,
    goal_id: row.goal_id || null,
    run_id: row.run_id || null,
    task_id: row.task_id || null,
    team_id: row.team_id || null,
    project_id: row.project_id || null,
    reason: row.reason || "manual",
    process_status: row.process_status || "running",
    status: row.status || "running",
    failure_kind: row.failure_kind || null,
    error_text: row.error_text || null,
    goal_status: row.goal_status || null,
    goal_status_reason: row.goal_status_reason || null,
    summary: row.summary || null,
    checkpoint_note: row.checkpoint_note || null,
    validation_summary: row.validation_summary || null,
    task_creations: jsonArray(row.task_creations_json),
    task_assignments: jsonArray(row.task_assignments_json),
    task_deletions: jsonArray(row.task_deletions_json),
    advisory_notes: jsonArray(row.advisory_notes_json),
    next_review_hint: Object.keys(nextReviewHint).length ? nextReviewHint : null,
    next_review_due_at: row.next_review_due_at ?? null,
    next_review_event: row.next_review_event || null,
    next_review_consumed_at: row.next_review_consumed_at ?? null,
    tasks_created: row.tasks_created || 0,
    tasks_assigned: row.tasks_assigned || 0,
    tasks_deleted: row.tasks_deleted || 0,
    notes_posted: row.notes_posted || 0,
    cost_usd: row.cost_usd ?? null,
    started_at: row.started_at ?? null,
    ended_at: row.ended_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    task_title: row.task_title || null,
  };
}

export function recordLeadCycleStarted(db, {
  goalId = null,
  runId,
  taskId = null,
  teamId = null,
  projectId = null,
  reason = "manual",
  startedAt = Date.now(),
} = {}) {
  if (!runId) return null;
  return leadCycleFromRow(insertLeadCycle(db, {
    id: runId,
    goalId,
    runId,
    taskId,
    teamId,
    projectId,
    reason,
    processStatus: "running",
    status: "running",
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  }));
}

export function recordLeadCycleCompleted(db, {
  runId,
  result,
  processStatus = "succeeded",
  status = "complete",
  failureKind = null,
  errorText = null,
  costUsd = null,
  tasksCreated = 0,
  tasksAssigned = 0,
  tasksDeleted = 0,
  notesPosted = 0,
  endedAt = Date.now(),
} = {}) {
  if (!runId) return null;
  const existing = ensureLeadCycleForRun(db, runId);
  if (!existing) return null;
  const hint = normalizeReviewHint(result?.next_review_hint || null);
  const dueAt = nextReviewDueAt(hint, endedAt);
  const event = hint.after_event || null;
  updateLeadCycleByRunId(db, runId, [
    "process_status = ?",
    "status = ?",
    "failure_kind = ?",
    "error_text = ?",
    "goal_status = ?",
    "goal_status_reason = ?",
    "summary = ?",
    "checkpoint_note = ?",
    "validation_summary = ?",
    "task_creations_json = ?",
    "task_assignments_json = ?",
    "task_deletions_json = ?",
    "advisory_notes_json = ?",
    "next_review_hint_json = ?",
    "next_review_due_at = ?",
    "next_review_event = ?",
    "tasks_created = ?",
    "tasks_assigned = ?",
    "tasks_deleted = ?",
    "notes_posted = ?",
    "cost_usd = ?",
    "ended_at = ?",
    "updated_at = ?",
  ], [
    processStatus || "succeeded",
    status || "complete",
    failureKind || null,
    errorText || null,
    result?.goal_status || null,
    result?.goal_status_reason || null,
    result?.summary || null,
    result?.checkpoint_note || null,
    result?.validation_summary || null,
    JSON.stringify(Array.isArray(result?.task_creations) ? result.task_creations : []),
    JSON.stringify(Array.isArray(result?.task_assignments) ? result.task_assignments : []),
    JSON.stringify(Array.isArray(result?.task_deletions) ? result.task_deletions : []),
    JSON.stringify(Array.isArray(result?.advisory_notes) ? result.advisory_notes : []),
    JSON.stringify(result?.next_review_hint || {}),
    dueAt,
    event,
    Number(tasksCreated) || 0,
    Number(tasksAssigned) || 0,
    Number(tasksDeleted) || 0,
    Number(notesPosted) || 0,
    costUsd ?? null,
    endedAt,
    endedAt,
  ]);
  const row = getLeadCycleByRunId(db, runId);
  if (row?.goal_id && result?.goal_status) {
    db.prepare(`
      UPDATE goals
      SET status = ?, status_reason = ?, last_lead_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      result.goal_status,
      result.goal_status_reason || null,
      endedAt,
      endedAt,
      row.goal_id,
    );
  }
  return leadCycleFromRow(row);
}

export function recordLeadCycleFailed(db, {
  runId,
  processStatus = "failed",
  status = "error",
  failureKind = null,
  errorText = null,
  costUsd = null,
  endedAt = Date.now(),
} = {}) {
  return recordLeadCycleCompleted(db, {
    runId,
    result: null,
    processStatus,
    status,
    failureKind,
    errorText,
    costUsd,
    endedAt,
  });
}

export function listLeadCyclesForGoal(db, goalId, { limit = 50 } = {}) {
  return listLeadCyclesByGoal(db, goalId, { limit }).map(leadCycleFromRow);
}

export function listDueLeadCycleFollowups(db, { now = Date.now(), limit = 20 } = {}) {
  return listDueLeadCycleFollowupRows(db, { now, limit }).map(leadCycleFromRow);
}

export function listMatchingLeadCycleEventFollowups(db, { teamId, projectId, event, limit = 20 } = {}) {
  return listMatchingLeadCycleEventFollowupRows(db, { teamId, projectId, event, limit }).map(leadCycleFromRow);
}

export function consumeLeadCycleFollowup(db, cycleId, consumedAt = Date.now()) {
  markLeadCycleReviewConsumed(db, cycleId, consumedAt);
}
