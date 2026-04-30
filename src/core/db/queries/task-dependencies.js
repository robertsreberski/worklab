// task_dependencies queries — blocker edges between tasks.

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
