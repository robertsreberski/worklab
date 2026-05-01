function normalizedProcessStatus(run) {
  return run?.process_status || run?.processStatus || "running";
}

export function buildRunLifecycleEvent(db, type, runId, fallback = {}) {
  const row = db && runId
    ? db.prepare(`
        SELECT
          r.id, r.task_id, r.mode, r.stage, r.agent_name, r.status,
          r.process_status, r.failure_kind, r.error_text,
          t.task_key, t.title AS task_title,
          a.display_name AS agent_display_name
        FROM task_runs r
        LEFT JOIN tasks t ON t.id = r.task_id
        LEFT JOIN agents a ON a.name = r.agent_name
        WHERE r.id = ?
      `).get(runId)
    : null;

  const status = row?.status || fallback.status || null;
  return {
    type,
    runId,
    taskId: row?.task_id || fallback.taskId || null,
    taskKey: row?.task_key || fallback.taskKey || null,
    taskTitle: row?.task_title || fallback.taskTitle || null,
    mode: row?.mode || fallback.mode || null,
    stage: row?.stage || fallback.stage || null,
    agentName: row?.agent_name || fallback.agentName || null,
    agentDisplayName: row?.agent_display_name || fallback.agentDisplayName || null,
    status,
    processStatus: normalizedProcessStatus(row || { status, processStatus: fallback.processStatus }),
    failureKind: row?.failure_kind || fallback.failureKind || null,
    errorText: row?.error_text || fallback.errorText || null,
  };
}
