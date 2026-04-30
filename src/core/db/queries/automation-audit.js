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
