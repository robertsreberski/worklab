// task_comments queries.

export function listTaskComments(db, taskId) {
  return db
    .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
    .all(taskId);
}

export function getCommentById(db, commentId) {
  return db.prepare("SELECT * FROM task_comments WHERE id = ?").get(commentId);
}

export function getTaskCommentById(db, commentId, taskId) {
  return db
    .prepare("SELECT * FROM task_comments WHERE id = ? AND task_id = ?")
    .get(commentId, taskId);
}

export function listAllCommentBodiesForKbUsage(db) {
  return db.prepare("SELECT task_id, body FROM task_comments").all();
}

export function listProjectCommentBodiesForKbUsage(db) {
  return db.prepare(`
    SELECT t.project_id, c.body
    FROM task_comments c
    JOIN tasks t ON t.id = c.task_id
    WHERE t.project_id IS NOT NULL
  `).all();
}

export function insertSystemComment(db, { id, taskId, body, createdAt }) {
  db.prepare(
    `INSERT INTO task_comments (id, task_id, author_type, body, created_at)
     VALUES (?, ?, 'system', ?, ?)`,
  ).run(id, taskId, body, createdAt);
}

export function insertHumanComment(db, { id, taskId, body, createdAt }) {
  db.prepare(
    `INSERT INTO task_comments (id, task_id, author_type, body, created_at)
     VALUES (?, ?, 'human', ?, ?)`,
  ).run(id, taskId, body, createdAt);
}

export function insertAuthoredComment(db, { id, taskId, authorType, authorId, body, createdAt }) {
  db.prepare(
    `INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, taskId, authorType, authorId || null, body, createdAt);
}

export function deleteCommentByIdAndTaskId(db, commentId, taskId) {
  db.prepare("DELETE FROM task_comments WHERE id = ? AND task_id = ?").run(commentId, taskId);
}
