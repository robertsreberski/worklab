// task_edges queries — parent/child delegation relationships.

export function deleteSubtaskEdgesForParent(db, parentTaskId) {
  db.prepare(
    "DELETE FROM task_edges WHERE parent_task_id = ? AND edge_type = 'subtask'",
  ).run(parentTaskId);
}

export function isSubtaskEdge(db, parentTaskId, childTaskId) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM task_edges WHERE parent_task_id = ? AND child_task_id = ? AND edge_type = 'subtask'",
      )
      .get(parentTaskId, childTaskId),
  );
}

export function insertSubtaskEdge(db, { parentTaskId, childTaskId, required, createdByRunId, createdAt }) {
  db.prepare(
    `INSERT INTO task_edges
       (parent_task_id, child_task_id, edge_type, required, created_by_run_id, created_at)
     VALUES (?, ?, 'subtask', ?, ?, ?)`,
  ).run(parentTaskId, childTaskId, required ? 1 : 0, createdByRunId || null, createdAt);
}
