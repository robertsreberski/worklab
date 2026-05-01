export function selectActiveRunId(runs = [], activeRunId = null, { preserveMissingActive = false } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return preserveMissingActive && activeRunId ? activeRunId : null;
  }
  if (runs.some((run) => run.id === activeRunId)) return activeRunId;
  if (preserveMissingActive && activeRunId) return activeRunId;
  return runs[0].id;
}

export function selectHighlightedRunId(runs = [], highlightedRunId = null, { preserveMissingActive = false } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return preserveMissingActive && highlightedRunId ? highlightedRunId : null;
  }
  if (runs.some((run) => run.id === highlightedRunId)) return highlightedRunId;
  if (preserveMissingActive && highlightedRunId) return highlightedRunId;
  return null;
}

export function optimisticTaskDetailRunStarted(data, { runId, startedAt = Date.now() } = {}) {
  if (!data?.task || !runId) return data;
  const task = data.task;
  const runningRun = {
    id: runId,
    task_id: task.id || null,
    task_key: task.task_key || null,
    status: "running",
    process_status: "running",
    stage: task.stage || "execute",
    mode: task.stage || "execute",
    started_at: startedAt,
    agent_name: task.owner_agent || null,
  };
  return {
    ...data,
    task: {
      ...task,
      running_run_id: runId,
      running_run_started_at: startedAt,
      running_run: runningRun,
    },
    comments: [...(data.comments || [])],
    runs: [
      runningRun,
      ...(data.runs || []).filter((run) => run?.id !== runId),
    ],
  };
}
