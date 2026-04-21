import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

export function loadConfig(env = process.env) {
  return {
    port: parseInt(env.WORKLAB_PORT || "7878", 10),
    dataDir: env.WORKLAB_DATA_DIR || resolve(repoRoot, "data"),
    workspace: env.WORKLAB_WORKSPACE || resolve(homedir(), "worklab-workspace"),
    logLevel: env.WORKLAB_LOG_LEVEL || "info",
    timezone: env.WORKLAB_TIMEZONE,
    repoRoot,
  };
}

export const config = loadConfig();
