// task_dependencies queries — blocker edges between tasks.

const TASK_SUMMARY_SELECT = `
  t.id,
  t.task_key,
  t.title,
  t.stage,
  t.updated_at,
  t.owner_agent,
  t.planner_agent,
  t.reviewer_agent,
  t.run_policy,
  t.project_id
`;

export function listDependentsOf(db, taskId) {
  return db
    .prepare(
      "SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ? ORDER BY created_at ASC",
    )
    .all(taskId);
}

export function findOpenBlocker(db, taskId) {
  return db
    .prepare(`
      SELECT t.id, t.title
      FROM task_dependencies d
      JOIN tasks t ON t.id = d.depends_on_task_id
      WHERE d.task_id = ? AND COALESCE(t.stage, 'plan') <> 'done'
      ORDER BY t.updated_at DESC
      LIMIT 1
    `)
    .get(taskId);
}

export function insertDependency(db, taskId, dependsOnTaskId, createdAt) {
  db.prepare(
    "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)",
  ).run(taskId, dependsOnTaskId, createdAt);
}

export function listDependsOnTaskIds(db, taskId) {
  return db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?").all(taskId);
}

// Bulk: blockers (depends_on_task_id) per owning task — joined with the
// blocker's full task row for compact summary projection.
export function listBlockedByForTasks(db, taskIds) {
  if (!taskIds.length) return [];
  const placeholders = taskIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT d.task_id AS owner_task_id, ${TASK_SUMMARY_SELECT}
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id
    WHERE d.task_id IN (${placeholders})
    ORDER BY d.task_id, t.updated_at DESC, t.rowid DESC
  `).all(...taskIds);
}

// Bulk: dependents (task_id depending on owner) per owning task — used for
// the "blocks" reverse summary.
export function listBlocksForTasks(db, taskIds) {
  if (!taskIds.length) return [];
  const placeholders = taskIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT d.depends_on_task_id AS owner_task_id, ${TASK_SUMMARY_SELECT}
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id
    WHERE d.depends_on_task_id IN (${placeholders})
    ORDER BY d.depends_on_task_id, t.updated_at DESC, t.rowid DESC
  `).all(...taskIds);
}

// Single-task variants for the per-task detail endpoint.
export function listDirectDependencyRows(db, taskId) {
  return db.prepare(`
    SELECT ${TASK_SUMMARY_SELECT}
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id
    WHERE d.task_id = ?
    ORDER BY t.updated_at DESC, t.rowid DESC
  `).all(taskId);
}

export function listDirectDependentRows(db, taskId) {
  return db.prepare(`
    SELECT ${TASK_SUMMARY_SELECT}
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id
    WHERE d.depends_on_task_id = ?
    ORDER BY t.updated_at DESC, t.rowid DESC
  `).all(taskId);
}

export function deleteAllDependenciesForTask(db, taskId) {
  db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
}

// Replace the full dependency edge set for a task in a single transaction.
// Caller must pre-validate the IDs (no self-dep, no cycles).
export function replaceDependenciesForTask(db, taskId, dependencyIds, createdAt) {
  const insert = db.prepare(
    "INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)",
  );
  db.transaction(() => {
    db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
    for (const dependencyId of dependencyIds) insert.run(taskId, dependencyId, createdAt);
  })();
}
