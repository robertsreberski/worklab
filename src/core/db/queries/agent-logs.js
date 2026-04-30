// agent_logs table queries — persisted-event blobs for completed runs.

export function getAgentLogByRunId(db, runId) {
  return db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(runId);
}

export function getAgentLogEvents(db, runId) {
  return db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(runId);
}
