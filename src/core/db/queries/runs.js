// task_runs queries. Live event/log mutations span many call sites; this
// file owns the high-frequency reads and the targeted writes that recur
// verbatim across modules.

export function getRunById(db, runId) {
  return db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId);
}

export function getRunRawOutputPath(db, runId) {
  return db.prepare("SELECT raw_output_path FROM task_runs WHERE id = ?").get(runId);
}

export function getRunCoreFields(db, runId) {
  return db
    .prepare("SELECT id, process_status, status, provider_kind FROM task_runs WHERE id = ?")
    .get(runId);
}

export function getRunDiagnostics(db, runId) {
  return db.prepare("SELECT diagnostics_json FROM task_runs WHERE id = ?").get(runId);
}

export function getRunWarningsAndDiagnostics(db, runId) {
  return db
    .prepare("SELECT warnings_json, diagnostics_json FROM task_runs WHERE id = ?")
    .get(runId);
}

export function getRunTranscriptTail(db, runId) {
  return db.prepare("SELECT transcript_tail_json FROM task_runs WHERE id = ?").get(runId);
}

export function setRunWorkerPid(db, runId, pid) {
  db.prepare("UPDATE task_runs SET worker_pid = ? WHERE id = ?").run(pid || null, runId);
}

export function setRunRawOutputPath(db, runId, path) {
  db.prepare("UPDATE task_runs SET raw_output_path = ? WHERE id = ?").run(path, runId);
}

export function setRunDiagnostics(db, runId, diagnosticsJson) {
  db.prepare("UPDATE task_runs SET diagnostics_json = ? WHERE id = ?").run(diagnosticsJson, runId);
}

export function setRunExecenvPath(db, runId, execenvPath) {
  db.prepare("UPDATE task_runs SET execenv_path = ? WHERE id = ?").run(execenvPath, runId);
}

export function setRunTranscriptTail(db, runId, transcriptTailJson) {
  db.prepare("UPDATE task_runs SET transcript_tail_json = ? WHERE id = ?").run(transcriptTailJson, runId);
}

export function deleteRunById(db, runId) {
  db.prepare("DELETE FROM task_runs WHERE id = ?").run(runId);
}

export function agentHasRunningRun(db, agentName) {
  return Boolean(
    db
      .prepare("SELECT id FROM task_runs WHERE agent_name = ? AND status = 'running' LIMIT 1")
      .get(agentName),
  );
}

// Recent runs for an agent — used by AgentEdit's "Recent runs" panel and the
// "N runs" pill on the Agents list. Joins task title/key and agent-log usage
// data to render in a single round-trip.
export function listRecentAgentRuns(db, agentName, limit) {
  return db.prepare(`
    SELECT r.id, r.task_id, r.mode, r.status, r.started_at, r.ended_at,
           t.title AS task_title,
           t.task_key AS task_key,
           l.model, l.cost_usd, l.duration_ms, l.input_tokens, l.output_tokens
    FROM task_runs r
    LEFT JOIN tasks t ON t.id = r.task_id
    LEFT JOIN agent_logs l ON l.task_run_id = r.id
    WHERE r.agent_name = ?
    ORDER BY r.started_at DESC
    LIMIT ?
  `).all(agentName, limit);
}
