export function createPendingTaskScheduler({
  active,
  pendingStarts,
  canStart,
  run,
} = {}) {
  function isPendingOrActive(taskId) {
    return !!(active?.has?.(taskId) || pendingStarts?.has?.(taskId));
  }

  function schedule(taskId, onError) {
    if (!taskId) return false;
    if (typeof canStart === "function" && !canStart(taskId)) return false;
    if (isPendingOrActive(taskId)) return false;
    pendingStarts?.add?.(taskId);
    setTimeout(() => {
      pendingStarts?.delete?.(taskId);
      if (typeof canStart === "function" && !canStart(taskId)) return;
      const handleError = (err) => {
        if (typeof onError === "function") onError(err);
      };
      try {
        Promise.resolve(run?.(taskId)).catch(handleError);
      } catch (err) {
        handleError(err);
      }
    }, 0);
    return true;
  }

  return { schedule };
}
