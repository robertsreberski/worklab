// automation_runs / automation_triggers audit-record inserts. Both tables
// are append-only audit logs for automation firings.

export function insertAutomationRun(db, { id, automationId, runId, triggerType, firedAt }) {
  db.prepare(
    `INSERT INTO automation_runs (id, automation_id, run_id, trigger_type, fired_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, automationId, runId, triggerType, firedAt);
}

export function insertAutomationTrigger(db, { id, automationId, taskId, runId, triggerType, outcome, reason, firedAt }) {
  db.prepare(
    `INSERT INTO automation_triggers
       (id, automation_id, task_id, run_id, trigger_type, outcome, reason, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, automationId, taskId || null, runId || null, triggerType, outcome, reason || null, firedAt);
}

export function listAutomationRunIds(db, automationId) {
  return db
    .prepare("SELECT run_id FROM automation_runs WHERE automation_id = ?")
    .all(automationId);
}

export function countAutomationRunsSince(db, automationId, since) {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id = ? AND fired_at >= ?")
      .get(automationId, since)?.count || 0
  );
}

// Recent automation runs, joined with task_runs + agent_logs for cost/timing.
// Powers the automation list/detail UI.
export function listAutomationRecentRuns(db, automationId, limit) {
  return db.prepare(`
    SELECT
      r.*,
      ar.automation_id,
      ar.trigger_type,
      ar.fired_at,
      l.model,
      l.duration_ms,
      l.input_tokens,
      l.output_tokens,
      l.cost_usd
    FROM automation_runs ar
    JOIN task_runs r ON r.id = ar.run_id
    LEFT JOIN agent_logs l ON l.task_run_id = r.id
    WHERE ar.automation_id = ?
    ORDER BY ar.fired_at DESC
    LIMIT ?
  `).all(automationId, limit);
}

export function listAutomationRecentTriggers(db, automationId, limit) {
  return db.prepare(`
    SELECT id, automation_id, task_id, run_id, trigger_type, outcome, reason, fired_at
    FROM automation_triggers
    WHERE automation_id = ?
    ORDER BY fired_at DESC, rowid DESC
    LIMIT ?
  `).all(automationId, limit);
}
