export function selectActiveRunId(runs = [], activeRunId = null, { preserveMissingActive = false } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return preserveMissingActive && activeRunId ? activeRunId : null;
  }
  if (runs.some((run) => run.id === activeRunId)) return activeRunId;
  if (preserveMissingActive && activeRunId) return activeRunId;
  return runs[0].id;
}
