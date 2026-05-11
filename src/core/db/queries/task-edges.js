// task_edges queries — parent/child delegation relationships.

const CHILD_TASK_SUMMARY_SELECT = `
  t.id,
  t.task_key,
  t.title,
  t.stage,
  t.updated_at,
  t.created_at,
  t.subtask_order,
  t.owner_agent,
  t.planner_agent,
  t.reviewer_agent,
  t.run_policy,
  t.project_id
`;

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
    SELECT ${CHILD_TASK_SUMMARY_SELECT}, e.required AS edge_required, e.edge_type
    FROM task_edges e
    JOIN tasks t ON t.id = e.child_task_id
    WHERE e.parent_task_id = ? AND e.edge_type = 'subtask'
    ORDER BY t.subtask_order ASC, t.created_at ASC
  `).all(parentTaskId);
}

// R6: list the agent names assigned to a parent's delegated children. Used
// by the watcher to evaluate `parent_review_policy = skip_when_qa_child`
// without paying for the full child rows.
export function listSubtaskChildAgents(db, parentTaskId) {
  return db.prepare(`
    SELECT t.owner_agent AS agent_name
    FROM task_edges e
    JOIN tasks t ON t.id = e.child_task_id
    WHERE e.parent_task_id = ? AND e.edge_type = 'subtask'
  `).all(parentTaskId).map((row) => row.agent_name).filter(Boolean);
}

// Bulk: subtask children for many parents — owner_task_id is the parent.
export function listSubtaskChildrenForParents(db, parentTaskIds) {
  if (!parentTaskIds.length) return [];
  const placeholders = parentTaskIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT e.parent_task_id AS owner_task_id, e.required AS edge_required, e.edge_type, ${CHILD_TASK_SUMMARY_SELECT}
    FROM task_edges e
    JOIN tasks t ON t.id = e.child_task_id
    WHERE e.parent_task_id IN (${placeholders}) AND e.edge_type = 'subtask'
    ORDER BY e.parent_task_id, t.subtask_order ASC, t.created_at ASC
  `).all(...parentTaskIds);
}
