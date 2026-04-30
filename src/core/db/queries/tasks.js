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
