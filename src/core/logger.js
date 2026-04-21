import pino from "pino";

export function createLogger(options = {}) {
  return pino({
    level: process.env.WORKLAB_LOG_LEVEL || "info",
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options,
  });
}

export const logger = createLogger();
