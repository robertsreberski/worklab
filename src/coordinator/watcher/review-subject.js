export function latestPriorExecuteRunId(db, taskId) {
  return db.prepare(`
    SELECT id
    FROM task_runs
    WHERE task_id = ?
      AND mode = 'execute'
    ORDER BY ended_at DESC, started_at DESC, rowid DESC
    LIMIT 1
  `).get(taskId)?.id || null;
}

export function reviewSubjectRunIdFor(db, run, taskId) {
  if (run?.parent_run_id) {
    const parent = db.prepare("SELECT id, mode FROM task_runs WHERE id = ?").get(run.parent_run_id);
    if (parent?.mode === "execute") return parent.id;
  }
  return latestPriorExecuteRunId(db, taskId);
}
