// task_attachments queries.

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

export function listTaskInstructionAttachments(db, taskId) {
  return db.prepare(`
    SELECT *
    FROM task_attachments
    WHERE task_id = ? AND owner_type = 'task_instructions'
    ORDER BY created_at, id
  `).all(taskId);
}

export function listAttachmentsByCommentIds(db, commentIds) {
  const ids = [...new Set((commentIds || []).filter(Boolean))];
  if (!ids.length) return [];
  return db.prepare(`
    SELECT *
    FROM task_attachments
    WHERE comment_id IN (${placeholders(ids)})
    ORDER BY created_at, id
  `).all(...ids);
}

export function getTaskAttachmentById(db, taskId, attachmentId) {
  return db.prepare(`
    SELECT *
    FROM task_attachments
    WHERE id = ? AND task_id = ?
  `).get(attachmentId, taskId);
}

export function insertTaskAttachment(db, row) {
  db.prepare(`
    INSERT INTO task_attachments
      (id, task_id, comment_id, owner_type, kind, source, label, path_text,
       absolute_path, filename, mime_type, size_bytes, stored_path,
       metadata_json, created_at)
    VALUES
      (@id, @task_id, @comment_id, @owner_type, @kind, @source, @label,
       @path_text, @absolute_path, @filename, @mime_type, @size_bytes,
       @stored_path, @metadata_json, @created_at)
  `).run({
    id: row.id,
    task_id: row.task_id,
    comment_id: row.comment_id || null,
    owner_type: row.owner_type,
    kind: row.kind,
    source: row.source || row.kind,
    label: row.label || "",
    path_text: row.path_text || null,
    absolute_path: row.absolute_path || null,
    filename: row.filename || null,
    mime_type: row.mime_type || null,
    size_bytes: row.size_bytes ?? null,
    stored_path: row.stored_path || null,
    metadata_json: row.metadata_json || "{}",
    created_at: row.created_at,
  });
}

export function deleteTaskInstructionAttachmentsExcept(db, taskId, keepIds) {
  const ids = [...new Set((keepIds || []).filter(Boolean))];
  if (!ids.length) {
    db.prepare("DELETE FROM task_attachments WHERE task_id = ? AND owner_type = 'task_instructions'").run(taskId);
    return;
  }
  db.prepare(`
    DELETE FROM task_attachments
    WHERE task_id = ?
      AND owner_type = 'task_instructions'
      AND id NOT IN (${placeholders(ids)})
  `).run(taskId, ...ids);
}
