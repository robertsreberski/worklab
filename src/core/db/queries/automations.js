// automations-table queries.

export function getAutomationById(db, id) {
  return db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
}

export function listEnabledAutomations(db) {
  return db
    .prepare("SELECT * FROM automations WHERE enabled = 1 ORDER BY updated_at DESC")
    .all();
}

export function listTaskAutomations(db, taskId) {
  return db
    .prepare("SELECT * FROM automations WHERE task_id = ? ORDER BY updated_at DESC, rowid DESC")
    .all(taskId);
}

export function getTaskAutomation(db, automationId, taskId) {
  return db
    .prepare("SELECT * FROM automations WHERE id = ? AND task_id = ?")
    .get(automationId, taskId);
}

export function deleteAutomation(db, id) {
  db.prepare("DELETE FROM automations WHERE id = ?").run(id);
}

export function listAllAutomations(db) {
  return db
    .prepare("SELECT * FROM automations ORDER BY updated_at DESC, rowid DESC")
    .all();
}

export function getAutomationIdAndTaskId(db, id) {
  return db.prepare("SELECT id, task_id FROM automations WHERE id = ?").get(id);
}

export function insertAutomation(db, {
  id,
  taskId,
  title,
  instructions,
  agentName,
  tagsJson,
  triggerJson,
  enabled,
  nextFireAt,
  createdAt,
  updatedAt,
}) {
  db.prepare(`
    INSERT INTO automations (
      id, task_id, title, instructions, agent_name, tags, trigger_json,
      enabled, next_fire_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskId || null,
    title,
    instructions || "",
    agentName || null,
    tagsJson,
    triggerJson,
    enabled ? 1 : 0,
    nextFireAt,
    createdAt,
    updatedAt,
  );
}

export function updateTaskBoundAutomation(db, {
  id,
  taskId,
  title,
  triggerJson,
  enabled,
  nextFireAt,
  updatedAt,
}) {
  db.prepare(`
    UPDATE automations
    SET title = ?, trigger_json = ?, enabled = ?, next_fire_at = ?, updated_at = ?
    WHERE id = ? AND task_id = ?
  `).run(title, triggerJson, enabled ? 1 : 0, nextFireAt, updatedAt, id, taskId);
}

export function updateAutomation(db, {
  id,
  title,
  instructions,
  agentName,
  tagsJson,
  triggerJson,
  enabled,
  nextFireAt,
  updatedAt,
}) {
  db.prepare(`
    UPDATE automations
    SET title = ?, instructions = ?, agent_name = ?, tags = ?,
        trigger_json = ?, enabled = ?, next_fire_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    title,
    instructions || "",
    agentName || null,
    tagsJson,
    triggerJson,
    enabled ? 1 : 0,
    nextFireAt,
    updatedAt,
    id,
  );
}
