export function getGoalById(db, id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM goals WHERE id = ?").get(id);
}

export function getGoalByTeamProject(db, { teamId, projectId } = {}) {
  if (!teamId || !projectId) return null;
  return db.prepare("SELECT * FROM goals WHERE team_id = ? AND project_id = ?").get(teamId, projectId);
}

export function listGoalsForTeam(db, teamId, { includeArchived = true } = {}) {
  if (!teamId) return [];
  return db.prepare(`
    SELECT g.*
    FROM goals g
    JOIN projects p ON p.id = g.project_id
    WHERE g.team_id = ?
      ${includeArchived ? "" : "AND p.archived = 0"}
    ORDER BY
      CASE g.status
        WHEN 'in_progress' THEN 0
        WHEN 'blocked' THEN 1
        WHEN 'complete' THEN 2
        ELSE 3
      END,
      COALESCE(g.last_lead_at, g.updated_at) DESC,
      p.name COLLATE NOCASE ASC
  `).all(teamId);
}

export function listGoals(db, { includeArchived = true, limit = 500 } = {}) {
  return db.prepare(`
    SELECT g.*
    FROM goals g
    JOIN teams t ON t.id = g.team_id
    JOIN projects p ON p.id = g.project_id
    WHERE t.status <> 'archived'
      ${includeArchived ? "" : "AND p.archived = 0"}
    ORDER BY
      CASE g.status
        WHEN 'in_progress' THEN 0
        WHEN 'blocked' THEN 1
        WHEN 'complete' THEN 2
        ELSE 3
      END,
      COALESCE(g.last_lead_at, g.updated_at) DESC,
      t.name COLLATE NOCASE ASC,
      p.name COLLATE NOCASE ASC
    LIMIT ?
  `).all(limit);
}

export function upsertGoal(db, {
  id,
  teamId,
  projectId,
  rootTaskId = null,
  status = "in_progress",
  statusReason = null,
  contractJson = "{}",
  lastLeadAt = null,
  createdAt,
  updatedAt,
}) {
  if (!id || !teamId || !projectId) return null;
  const now = updatedAt || createdAt || Date.now();
  const existing = getGoalByTeamProject(db, { teamId, projectId });
  if (existing) {
    db.prepare(`
      UPDATE goals
      SET root_task_id = COALESCE(?, root_task_id),
          status = COALESCE(?, status),
          status_reason = ?,
          contract_json = COALESCE(?, contract_json),
          last_lead_at = COALESCE(?, last_lead_at),
          updated_at = ?
      WHERE id = ?
    `).run(rootTaskId, status, statusReason, contractJson, lastLeadAt, now, existing.id);
    return getGoalById(db, existing.id);
  }
  db.prepare(`
    INSERT INTO goals
      (id, team_id, project_id, root_task_id, status, status_reason, contract_json, last_lead_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    teamId,
    projectId,
    rootTaskId,
    status || "in_progress",
    statusReason || null,
    contractJson || "{}",
    lastLeadAt || null,
    createdAt || now,
    now,
  );
  return getGoalById(db, id);
}

export function updateGoalFields(db, goalId, fields, values) {
  if (!goalId || !fields.length) return;
  db.prepare(`UPDATE goals SET ${fields.join(", ")} WHERE id = ?`).run(...values, goalId);
}

export function getLeadCycleByRunId(db, runId) {
  if (!runId) return null;
  return db.prepare("SELECT * FROM lead_cycles WHERE run_id = ?").get(runId);
}

export function insertLeadCycle(db, {
  id,
  goalId = null,
  runId = null,
  taskId = null,
  teamId = null,
  projectId = null,
  reason = "manual",
  processStatus = "running",
  status = "running",
  startedAt = null,
  createdAt,
  updatedAt,
}) {
  const rowId = id || runId;
  if (!rowId) return null;
  const now = updatedAt || createdAt || startedAt || Date.now();
  db.prepare(`
    INSERT INTO lead_cycles
      (id, goal_id, run_id, task_id, team_id, project_id, reason, process_status, status, started_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      goal_id = COALESCE(excluded.goal_id, lead_cycles.goal_id),
      task_id = COALESCE(excluded.task_id, lead_cycles.task_id),
      team_id = COALESCE(excluded.team_id, lead_cycles.team_id),
      project_id = COALESCE(excluded.project_id, lead_cycles.project_id),
      reason = COALESCE(excluded.reason, lead_cycles.reason),
      process_status = excluded.process_status,
      status = excluded.status,
      started_at = COALESCE(excluded.started_at, lead_cycles.started_at),
      updated_at = excluded.updated_at
  `).run(
    rowId,
    goalId,
    runId,
    taskId,
    teamId,
    projectId,
    reason || "manual",
    processStatus || "running",
    status || "running",
    startedAt || now,
    createdAt || now,
    now,
  );
  return runId ? getLeadCycleByRunId(db, runId) : db.prepare("SELECT * FROM lead_cycles WHERE id = ?").get(rowId);
}

export function updateLeadCycleByRunId(db, runId, fields, values) {
  if (!runId || !fields.length) return;
  db.prepare(`UPDATE lead_cycles SET ${fields.join(", ")} WHERE run_id = ?`).run(...values, runId);
}

export function listLeadCyclesByGoal(db, goalId, { limit = 50 } = {}) {
  if (!goalId) return [];
  return db.prepare(`
    SELECT *
    FROM lead_cycles
    WHERE goal_id = ?
    ORDER BY COALESCE(started_at, created_at) DESC, rowid DESC
    LIMIT ?
  `).all(goalId, limit);
}

export function listLeadCyclesByTeam(db, teamId, { limit = 50 } = {}) {
  if (!teamId) return [];
  return db.prepare(`
    SELECT lc.*, t.title AS task_title
    FROM lead_cycles lc
    LEFT JOIN tasks t ON t.id = lc.task_id
    WHERE lc.team_id = ?
    ORDER BY COALESCE(lc.started_at, lc.created_at) DESC, lc.rowid DESC
    LIMIT ?
  `).all(teamId, limit);
}

export function listDueLeadCycleFollowups(db, { now = Date.now(), limit = 20 } = {}) {
  return db.prepare(`
    SELECT *
    FROM lead_cycles
    WHERE next_review_due_at IS NOT NULL
      AND next_review_due_at <= ?
      AND next_review_consumed_at IS NULL
      AND process_status = 'succeeded'
      AND team_id IS NOT NULL
      AND project_id IS NOT NULL
    ORDER BY next_review_due_at ASC, rowid ASC
    LIMIT ?
  `).all(now, limit);
}

export function listMatchingLeadCycleEventFollowups(db, { teamId, projectId, event, limit = 20 } = {}) {
  if (!teamId || !projectId || !event) return [];
  return db.prepare(`
    SELECT *
    FROM lead_cycles
    WHERE team_id = ?
      AND project_id = ?
      AND next_review_event = ?
      AND next_review_consumed_at IS NULL
      AND process_status = 'succeeded'
    ORDER BY COALESCE(ended_at, started_at, created_at) ASC, rowid ASC
    LIMIT ?
  `).all(teamId, projectId, event, limit);
}

export function markLeadCycleReviewConsumed(db, id, consumedAt = Date.now()) {
  if (!id) return;
  db.prepare("UPDATE lead_cycles SET next_review_consumed_at = ?, updated_at = ? WHERE id = ?")
    .run(consumedAt, consumedAt, id);
}
