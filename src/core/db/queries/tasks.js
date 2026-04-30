// Tasks-table queries. Every SELECT/INSERT/UPDATE/DELETE against the `tasks`
// table should land here so callers don't reinvent SQL or scatter prepared
// statements. Phase 2 extracts the most repeated patterns first; bespoke
// SQL stays inline at call sites until the next pass.

export function getTaskById(db, id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

export function getTaskCoreFields(db, id) {
  return db.prepare(
    "SELECT id, stage, owner_agent, planner_agent, reviewer_agent, parent_task_id, root_task_id, run_policy FROM tasks WHERE id = ?",
  ).get(id);
}

export function getTaskStage(db, id) {
  return db.prepare("SELECT stage FROM tasks WHERE id = ?").get(id);
}

export function listSubtaskIds(db, parentTaskId) {
  return db
    .prepare("SELECT id FROM tasks WHERE parent_task_id = ? ORDER BY subtask_order ASC, created_at ASC")
    .all(parentTaskId)
    .map((row) => row.id);
}

export function countOpenChildren(db, parentTaskId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ? AND stage NOT IN ('done', 'blocked')",
    )
    .get(parentTaskId).n;
}

export function setTaskStage(db, id, stage, updatedAt) {
  db.prepare("UPDATE tasks SET stage = ?, updated_at = ? WHERE id = ?").run(stage, updatedAt, id);
}

export function setTaskStageReason(db, id, reason, updatedAt) {
  db.prepare("UPDATE tasks SET stage_reason = ?, updated_at = ? WHERE id = ?").run(reason, updatedAt, id);
}

export function listTaskHeadersForKbUsage(db) {
  return db.prepare("SELECT id, task_key, title, instructions, stage FROM tasks").all();
}

export function getTaskHeaderForKbUsage(db, id) {
  return db.prepare("SELECT id, task_key, title, stage FROM tasks WHERE id = ?").get(id);
}

export function countTasksByStageForProject(db, projectId) {
  return db
    .prepare(
      "SELECT stage, COUNT(*) AS count FROM tasks WHERE project_id = ? GROUP BY stage",
    )
    .all(projectId);
}

// Project-detail page: tasks with their unresolved-dependency count and
// running/last run snapshots. Two correlated subqueries pin the most-recent
// running and most-recent non-running run per task; the dependency subquery
// counts open dependencies.
export function listProjectTasksWithRunSnapshots(db, projectId) {
  return db.prepare(`
    SELECT
      t.id, t.task_key, t.title, t.stage, t.stage_reason, t.run_policy,
      t.owner_agent, t.planner_agent, t.reviewer_agent, t.parent_task_id,
      t.pending_actions_json, t.blocking_issues_json, t.failure_count,
      t.rejection_streak, t.last_failure_kind, t.error_text, t.updated_at,
      (
        SELECT COUNT(*)
        FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on_task_id
        WHERE d.task_id = t.id AND COALESCE(dep.stage, 'plan') <> 'done'
      ) AS unresolved_dependency_count,
      rr.id AS running_run_id,
      rr.status AS running_run_status,
      rr.process_status AS running_run_process_status,
      rr.started_at AS running_run_started_at,
      lr.id AS last_run_id,
      lr.status AS last_run_status,
      lr.process_status AS last_run_process_status,
      lr.failure_kind AS last_run_failure_kind,
      lr.ended_at AS last_run_ended_at,
      lr.stage AS last_run_stage,
      lr.mode AS last_run_mode,
      lr.decision AS last_run_decision,
      lr.summary AS last_run_summary
    FROM tasks t
    LEFT JOIN task_runs rr ON rr.id = (
      SELECT r.id
      FROM task_runs r
      WHERE r.task_id = t.id AND r.status = 'running'
      ORDER BY r.started_at DESC, r.rowid DESC
      LIMIT 1
    )
    LEFT JOIN task_runs lr ON lr.id = (
      SELECT r.id
      FROM task_runs r
      WHERE r.task_id = t.id AND r.status <> 'running'
      ORDER BY r.started_at DESC, r.rowid DESC
      LIMIT 1
    )
    WHERE t.project_id = ?
    ORDER BY t.updated_at DESC
  `).all(projectId);
}
