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

// Latest run summary for a task — used by compactChildTaskSummary.
export function getLatestTaskRunSummary(db, taskId) {
  return db.prepare(`
    SELECT id, mode, stage, status, process_status, decision, failure_kind,
           summary, details, artifact_summary_json, started_at, ended_at
    FROM task_runs
    WHERE task_id = ?
    ORDER BY started_at DESC, rowid DESC
    LIMIT 1
  `).get(taskId);
}

// Currently-running run for a task (for §9.3 derived running_run_id).
export function getRunningTaskRun(db, taskId) {
  return db.prepare(`
    SELECT id, status, process_status, started_at FROM task_runs
    WHERE task_id = ? AND status = 'running'
    ORDER BY started_at DESC LIMIT 1
  `).get(taskId);
}

// Latest non-running (last finished or errored) run for a task.
export function getLastNonRunningTaskRun(db, taskId) {
  return db.prepare(`
    SELECT id, status, process_status, failure_kind, ended_at, stage, mode, decision, summary
    FROM task_runs
    WHERE task_id = ? AND status <> 'running'
    ORDER BY started_at DESC LIMIT 1
  `).get(taskId);
}

// Bulk variant: running rows for many tasks plus event_count/last_event from
// the join with agent_logs. Caller groups by task_id.
export function listRunningRunsWithEventsForTasks(db, taskIds) {
  if (!taskIds.length) return [];
  const placeholders = taskIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT
      r.id, r.task_id, r.status, r.process_status, r.started_at,
      json_array_length(l.events) AS event_count,
      CASE
        WHEN l.events IS NOT NULL AND json_valid(l.events) AND json_array_length(l.events) > 0
        THEN json_extract(l.events, '$[' || (json_array_length(l.events) - 1) || ']')
        ELSE NULL
      END AS last_event_json
    FROM task_runs r
    LEFT JOIN agent_logs l ON l.task_run_id = r.id
    WHERE r.task_id IN (${placeholders}) AND r.status = 'running'
    ORDER BY r.task_id, r.started_at DESC, r.rowid DESC
  `).all(...taskIds);
}

// Bulk variant: most-recent non-running rows for many tasks.
export function listLastNonRunningRunsForTasks(db, taskIds) {
  if (!taskIds.length) return [];
  const placeholders = taskIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT id, task_id, status, process_status, failure_kind, ended_at, stage, mode, decision, summary
    FROM task_runs
    WHERE task_id IN (${placeholders}) AND status <> 'running'
    ORDER BY task_id, started_at DESC, rowid DESC
  `).all(...taskIds);
}

// Big task-runs join with logs + automations. Caller passes a WHERE clause
// (e.g. "WHERE r.task_id = ?") and bound params.
export function selectRunsWithLogJoin(db, whereClause, ...params) {
  return db.prepare(`
    SELECT
      r.*,
      l.id AS log_id,
      l.model AS log_model,
      l.effort AS log_effort,
      l.input_tokens AS log_input_tokens,
      l.output_tokens AS log_output_tokens,
      l.cache_read_tokens AS log_cache_read_tokens,
      l.cache_creation_tokens AS log_cache_creation_tokens,
      l.cost_usd AS log_cost_usd,
      l.duration_ms AS log_duration_ms,
      l.num_turns AS log_num_turns,
      l.status AS log_status,
      ar.automation_id,
      ar.trigger_type AS automation_trigger_type,
      ar.fired_at AS automation_fired_at,
      a.title AS automation_title,
      a.task_id AS automation_task_id
    FROM task_runs r
    LEFT JOIN agent_logs l ON l.task_run_id = r.id
    LEFT JOIN automation_runs ar ON ar.run_id = r.id
    LEFT JOIN automations a ON a.id = ar.automation_id
    ${whereClause}
    ORDER BY r.started_at DESC, r.rowid DESC
  `).all(...params);
}

// retry_stage / stage from the most-recent run on this task — used by
// /tasks/:id/retry to pick the right stage to retry from.
export function getLatestRetryStageRow(db, taskId) {
  return db.prepare(`
    SELECT retry_stage, stage
    FROM task_runs
    WHERE task_id = ?
      AND (retry_stage IN ('plan', 'execute', 'review') OR stage IN ('plan', 'execute', 'review'))
    ORDER BY COALESCE(ended_at, started_at, 0) DESC, started_at DESC, rowid DESC
    LIMIT 1
  `).get(taskId);
}

// id-only running-run lookup for "is the task already running?" guards.
export function getRunningRunIdForTask(db, taskId) {
  return db.prepare(
    "SELECT id FROM task_runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
  ).get(taskId);
}

export function taskHasRunningRun(db, taskId) {
  return Boolean(
    db
      .prepare("SELECT id FROM task_runs WHERE task_id = ? AND status = 'running' LIMIT 1")
      .get(taskId),
  );
}

// Stale `running` row left behind by a crashed worker — used by /cancel to
// reconcile the row even when the watcher has no live process.
export function getStaleRunningRunForTask(db, taskId) {
  return db.prepare(`
    SELECT id, stage FROM task_runs
    WHERE task_id = ? AND status = 'running'
    ORDER BY started_at DESC LIMIT 1
  `).get(taskId);
}

// Cost-summary aggregates for the /api/runs/cost-summary endpoint.
export function getCostSummarySince(db, sinceMs) {
  return db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS runs
    FROM task_runs
    WHERE started_at >= ? AND cost_usd IS NOT NULL
  `).get(sinceMs);
}

export function getCostSummaryByAgentSince(db, sinceMs) {
  return db.prepare(`
    SELECT agent_name, COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS runs
    FROM task_runs
    WHERE started_at >= ? AND cost_usd IS NOT NULL
    GROUP BY agent_name
    ORDER BY total DESC
  `).all(sinceMs);
}
