import { monitorEventLoopDelay } from "node:perf_hooks";

const DEFAULT_EVENT_LOOP_WARN_MS = 150;
const DEFAULT_EVENT_LOOP_SAMPLE_MS = 15_000;

export function eventLoopWarnThresholdMs(env = process.env) {
  const value = Number(env.WORKLAB_EVENT_LOOP_WARN_MS || DEFAULT_EVENT_LOOP_WARN_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_EVENT_LOOP_WARN_MS;
}

export function startEventLoopMonitor(logger, { env = process.env } = {}) {
  const thresholdMs = eventLoopWarnThresholdMs(env);
  if (!logger || thresholdMs === 0) return { shutdown() {} };
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const p95Ms = histogram.percentile(95) / 1e6;
    const maxMs = histogram.max / 1e6;
    if (p95Ms >= thresholdMs) {
      logger.warn({
        p95_ms: Math.round(p95Ms),
        max_ms: Math.round(maxMs),
        threshold_ms: thresholdMs,
      }, "event loop delay high");
    }
    histogram.reset();
  }, DEFAULT_EVENT_LOOP_SAMPLE_MS);
  timer.unref?.();
  return {
    shutdown() {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
