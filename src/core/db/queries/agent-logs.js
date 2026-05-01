// agent_logs table queries — persisted-event blobs for completed runs.

const AGENT_LOG_COLUMNS = `
  id, task_run_id, model, effort, input_tokens, output_tokens,
  cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms,
  num_turns, status, created_at
`;

export function getAgentLogByRunId(db, runId, { includeEvents = true } = {}) {
  const eventsColumn = includeEvents ? "events" : "NULL AS events";
  return db.prepare(`
    SELECT ${AGENT_LOG_COLUMNS}, ${eventsColumn}, json_array_length(events) AS event_count
    FROM agent_logs
    WHERE task_run_id = ?
  `).get(runId);
}

export function getAgentLogEvents(db, runId) {
  return db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(runId);
}
