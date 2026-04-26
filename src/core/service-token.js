import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export function mcpTokenPath(dataDir) {
  return join(dataDir, "mcp-token");
}

export function ensureMcpToken(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const path = mcpTokenPath(dataDir);
  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (token) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
  return token;
}

export function readMcpToken(dataDir) {
  const path = mcpTokenPath(dataDir);
  if (!existsSync(path)) return ensureMcpToken(dataDir);
  return readFileSync(path, "utf8").trim();
}

export function tokenMatches(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}
