import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "./env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

function parsePort(value) {
  const port = Number(value || "7878");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WORKLAB_PORT must be an integer from 1 to 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

function parseNonNegativeInt(value, fallback, name) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  return {
    port: parsePort(env.WORKLAB_PORT),
    host: env.WORKLAB_HOST || "127.0.0.1",
    dataDir: env.WORKLAB_DATA_DIR ? resolve(env.WORKLAB_DATA_DIR) : defaultDataDir(),
    workspace: env.WORKLAB_WORKSPACE || resolve(homedir(), "worklab-workspace"),
    logLevel: env.WORKLAB_LOG_LEVEL || "info",
    timezone: env.WORKLAB_TIMEZONE,
    runTimeoutMs: parseNonNegativeInt(env.WORKLAB_RUN_TIMEOUT_MS, 30 * 60 * 1000, "WORKLAB_RUN_TIMEOUT_MS"),
    runIdleWarningMs: parseNonNegativeInt(env.WORKLAB_RUN_IDLE_WARNING_MS, 120 * 1000, "WORKLAB_RUN_IDLE_WARNING_MS"),
    logInlineLimit: parseNonNegativeInt(env.WORKLAB_LOG_INLINE_LIMIT, 12_000, "WORKLAB_LOG_INLINE_LIMIT"),
    repoRoot,
  };
}

export function localClientHost(host) {
  if (!host || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

function formatHttpHost(host) {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function worklabBaseUrl(config = loadConfig()) {
  return `http://${formatHttpHost(localClientHost(config.host))}:${config.port}`;
}

export const config = loadConfig();
