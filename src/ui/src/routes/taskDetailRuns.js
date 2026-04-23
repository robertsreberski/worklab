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
