export function argValue(args = [], name) {
  const eqPrefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === name) {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      return value;
    }
    if (arg.startsWith(eqPrefix)) {
      const value = arg.slice(eqPrefix.length);
      if (!value) throw new Error(`${name} requires a value`);
      return value;
    }
  }
  return undefined;
}

export function hasFlag(args = [], name) {
  return args.includes(name);
}

function requireNonEmpty(value, name) {
  if (!String(value || "").trim()) throw new Error(`${name} requires a value`);
  return value;
}

export function applyConfigArgs(args = [], env = process.env) {
  const port = argValue(args, "--port");
  if (port !== undefined) {
    const normalizedPort = Number(port);
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      throw new Error("--port must be an integer from 1 to 65535");
    }
    env.WORKLAB_PORT = String(normalizedPort);
  }

  const host = argValue(args, "--host");
  if (host !== undefined) env.WORKLAB_HOST = requireNonEmpty(host, "--host");

  const dataDir = argValue(args, "--data-dir");
  if (dataDir !== undefined) env.WORKLAB_DATA_DIR = requireNonEmpty(dataDir, "--data-dir");

  const workspace = argValue(args, "--workspace");
  if (workspace !== undefined) env.WORKLAB_WORKSPACE = requireNonEmpty(workspace, "--workspace");

  // R5: --drain-timeout-ms maps to WORKLAB_DRAIN_TIMEOUT_MS so `worklab
  // start/restart/stop --drain-timeout-ms 30000` propagates the value to the
  // coordinator process spawned by the host service manager. The value is
  // capped at 10 minutes (600000ms) to bound shutdown latency.
  const drainTimeoutMs = argValue(args, "--drain-timeout-ms");
  if (drainTimeoutMs !== undefined) {
    const normalizedDrainTimeoutMs = Number(drainTimeoutMs);
    if (!Number.isFinite(normalizedDrainTimeoutMs) || normalizedDrainTimeoutMs < 0 || normalizedDrainTimeoutMs > 600_000) {
      throw new Error("--drain-timeout-ms must be an integer between 0 and 600000");
    }
    env.WORKLAB_DRAIN_TIMEOUT_MS = String(Math.floor(normalizedDrainTimeoutMs));
  }

  return env;
}
