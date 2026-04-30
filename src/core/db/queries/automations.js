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
