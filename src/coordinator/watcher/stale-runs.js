export function reconcileStaleRunningRuns(db, logger) {
  const now = Date.now();
  const reconcile = db.transaction(() => {
    const stale = db.prepare(
      `SELECT id, task_id, stage FROM task_runs
       WHERE process_status = 'running' OR status = 'running'`,
    ).all();
    if (stale.length === 0) return 0;
    const markRun = db.prepare(
      `UPDATE task_runs
       SET process_status = 'abandoned', status = 'error', ended_at = ?,
           failure_kind = 'abandoned', error_text = ?,
           cancel_initiator = COALESCE(cancel_initiator, 'stale_reconcile'),
           cancel_reason = COALESCE(cancel_reason, 'coordinator restarted while run was active')
       WHERE id = ?`,
    );
    const markTask = db.prepare(
      `UPDATE tasks
       SET stage = CASE WHEN stage = 'done' THEN stage ELSE COALESCE(?, stage, 'plan') END,
           error_text = COALESCE(error_text, ?),
           stage_reason = COALESCE(stage_reason, 'abandoned'),
           updated_at = ?
       WHERE id = ?`,
    );
    for (const row of stale) {
      const retryStage = row.stage || "plan";
      markRun.run(now, "coordinator restarted", row.id);
      markTask.run(retryStage, "Previous run did not finish", now, row.task_id);
    }
    return stale.length;
  });
  const count = reconcile();
  if (count > 0) logger?.warn?.({ count }, "reconciled stale running runs at boot");
  return count;
}
