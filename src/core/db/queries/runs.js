// task_runs queries. Live event/log mutations span many call sites; this
// file owns the high-frequency reads and the targeted writes that recur
// verbatim across modules.

export function getRunById(db, runId) {
  return db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId);
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
