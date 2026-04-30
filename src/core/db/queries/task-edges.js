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

export function listSubtaskChildrenForParent(db, parentTaskId) {
  return db.prepare(`
    SELECT t.*, e.required AS edge_required, e.edge_type
    FROM task_edges e
    JOIN tasks t ON t.id = e.child_task_id
    WHERE e.parent_task_id = ? AND e.edge_type = 'subtask'
    ORDER BY t.subtask_order ASC, t.created_at ASC
  `).all(parentTaskId);
}

// Bulk: subtask children for many parents — owner_task_id is the parent.
export function listSubtaskChildrenForParents(db, parentTaskIds) {
  if (!parentTaskIds.length) return [];
  const placeholders = parentTaskIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT e.parent_task_id AS owner_task_id, e.required AS edge_required, e.edge_type, t.*
    FROM task_edges e
    JOIN tasks t ON t.id = e.child_task_id
    WHERE e.parent_task_id IN (${placeholders}) AND e.edge_type = 'subtask'
    ORDER BY e.parent_task_id, t.subtask_order ASC, t.created_at ASC
  `).all(...parentTaskIds);
}
