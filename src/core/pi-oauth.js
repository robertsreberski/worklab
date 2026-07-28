import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePiOAuthApiKey } from "@mono-agent/agent-runtime/ai";

const ENV_API_KEYS = {
  "openai-codex": ["OPENAI_CODEX_API_KEY", "CODEX_API_KEY"],
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function authPathCandidates(dataDir) {
  if (!dataDir) return [];
  return [
    join(dataDir, "pi-auth.json"),
    join(dataDir, "auth.json"),
  ];
}

export function readPiAuthFile(dataDir) {
  for (const path of authPathCandidates(dataDir)) {
    if (!existsSync(path)) continue;
    const value = readJson(path);
    if (value && typeof value === "object") return { path, credentials: value };
  }
  return { path: dataDir ? join(dataDir, "pi-auth.json") : null, credentials: {} };
}

export function hasPiOAuthCredentials(providerId, { dataDir, env = process.env } = {}) {
  const envKeys = ENV_API_KEYS[providerId] || [];
  if (envKeys.some((key) => env[key])) return true;
  const { credentials } = readPiAuthFile(dataDir);
  return Boolean(credentials?.[providerId]);
}

export async function resolvePiApiKey(providerId, { dataDir, env = process.env } = {}) {
  const envKeys = ENV_API_KEYS[providerId] || [];
  for (const key of envKeys) {
    if (env[key]) return env[key];
  }

  const auth = readPiAuthFile(dataDir);
  if (!auth.credentials?.[providerId]) return undefined;
  // The runtime façade clones the record before handing it to Pi, so the
  // refreshed values only ever reach disk through newCredentials below.
  const result = await resolvePiOAuthApiKey(providerId, auth.credentials);
  if (!result?.apiKey) return undefined;

  if (auth.path) {
    const next = { ...auth.credentials, [providerId]: { type: "oauth", ...result.newCredentials } };
    mkdirSync(dirname(auth.path), { recursive: true });
    writeFileSync(auth.path, JSON.stringify(next, null, 2), "utf8");
  }
  return result.apiKey;
}
