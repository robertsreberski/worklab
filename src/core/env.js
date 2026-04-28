import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

export function defaultDataDir() {
  return join(homedir(), ".worklab");
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (line.includes("#") && !trimmed.includes('"') && !trimmed.includes("'")) {
    value = value.replace(/\s+#.*$/, "");
  }
  value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  return [key, value];
}

export function loadEnvFile(path, { override = false, env = process.env } = {}) {
  if (!existsSync(path)) return { loaded: false, path, keys: [] };
  const keys = [];
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (override || env[key] === undefined) {
      env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, path, keys };
}

export function resolveDataDirFromEnv(env = process.env) {
  return env.WORKLAB_DATA_DIR ? resolve(env.WORKLAB_DATA_DIR) : defaultDataDir();
}

export function bootstrapWorklabEnv({ env = process.env, createDataDir = false, repoEnvPath = join(repoRoot, ".env") } = {}) {
  const repoEnv = loadEnvFile(repoEnvPath, { override: false, env });
  const dataDir = resolveDataDirFromEnv(env);
  if (createDataDir) mkdirSync(dataDir, { recursive: true });
  const dataEnv = loadEnvFile(join(dataDir, ".env"), { override: false, env });
  return {
    loaded: repoEnv.loaded || dataEnv.loaded,
    path: dataEnv.path,
    keys: [...repoEnv.keys, ...dataEnv.keys],
    files: [repoEnv, dataEnv],
  };
}
