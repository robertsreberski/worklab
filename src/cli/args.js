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

function normalizePort(value, name = "--port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return String(port);
}

function requireNonEmpty(value, name) {
  if (!String(value || "").trim()) throw new Error(`${name} requires a value`);
  return value;
}

export function applyConfigArgs(args = [], env = process.env) {
  const port = argValue(args, "--port");
  if (port !== undefined) env.WORKLAB_PORT = normalizePort(port);

  const host = argValue(args, "--host");
  if (host !== undefined) env.WORKLAB_HOST = requireNonEmpty(host, "--host");

  const dataDir = argValue(args, "--data-dir");
  if (dataDir !== undefined) env.WORKLAB_DATA_DIR = requireNonEmpty(dataDir, "--data-dir");

  const workspace = argValue(args, "--workspace");
  if (workspace !== undefined) env.WORKLAB_WORKSPACE = requireNonEmpty(workspace, "--workspace");

  return env;
}
