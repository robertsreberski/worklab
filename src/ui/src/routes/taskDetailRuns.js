export function selectActiveRunId(runs = [], activeRunId = null) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  return runs.some((run) => run.id === activeRunId) ? activeRunId : runs[0].id;
}
