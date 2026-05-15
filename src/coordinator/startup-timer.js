export function createStartupTimer(logger) {
  const start = process.hrtime.bigint();
  let previous = start;
  return (phase, extra = {}) => {
    if (typeof logger?.info !== "function") return;
    const now = process.hrtime.bigint();
    const durationMs = Number(now - previous) / 1e6;
    const sinceStartMs = Number(now - start) / 1e6;
    previous = now;
    logger.info({
      phase,
      duration_ms: Math.round(durationMs),
      since_start_ms: Math.round(sinceStartMs),
      ...extra,
    }, "startup phase complete");
  };
}
