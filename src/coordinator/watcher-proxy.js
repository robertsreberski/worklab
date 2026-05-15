export function createWatcherProxy(watcherHolder) {
  return {
    handleRunRequested: (...args) => watcherHolder.current.handleRunRequested(...args),
    cancel: (...args) => watcherHolder.current.cancel(...args),
    shutdown: (...args) => watcherHolder.current.shutdown(...args),
    isActive: (...args) => watcherHolder.current.isActive(...args),
    getRunLiveInputState: (...args) => watcherHolder.current.getRunLiveInputState(...args),
    sendRunMessage: (...args) => watcherHolder.current.sendRunMessage(...args),
    maybeAutoStart: (...args) => watcherHolder.current.maybeAutoStart(...args),
    maybeAutoStartDependents: (...args) => watcherHolder.current.maybeAutoStartDependents(...args),
    maybeScheduleUnassignedTeamTask: (...args) => watcherHolder.current.maybeScheduleUnassignedTeamTask(...args),
    spawnLeadCycle: (...args) => watcherHolder.current.spawnLeadCycle(...args),
  };
}
