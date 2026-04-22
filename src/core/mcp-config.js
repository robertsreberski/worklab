import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

function isPrivateHost(host) {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function validateRemote(name, config) {
  const u = new URL(config.url);
  if (!isPrivateHost(u.hostname)) {
    throw new Error(`mcp server "${name}" url not in allowlist: ${config.url}`);
  }
  const out = { type: config.type, url: config.url };
  if (config.headers) out.headers = config.headers;
  return out;
}

function validateStdio(name, config) {
  if (!isAbsolute(config.command)) {
    throw new Error(`mcp server "${name}" command must be absolute path: ${config.command}`);
  }
  const out = { command: config.command };
  if (config.args) out.args = config.args;
  if (config.env) out.env = config.env;
  return out;
}

/**
 * Load and validate mcp.json from <dataDir>/config/mcp.json.
 * Returns {} if file is missing. Throws on validation failure.
 * @param {string} dataDir
 * @returns {Record<string, object>}
 */
export function loadMcpConfig(dataDir) {
  const p = join(dataDir, "config", "mcp.json");
  if (!existsSync(p)) return {};
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const servers = raw.mcpServers || {};
  const out = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.type === "http" || cfg.type === "sse") {
      out[name] = validateRemote(name, cfg);
    } else {
      out[name] = validateStdio(name, cfg);
    }
  }
  return out;
}

/**
 * Returns the built-in MCP server definitions for Worklab.
 * @param {string} repoRoot  Absolute path to the repo root
 * @returns {Record<string, object>}
 */
export function getBuiltinMcpServers(repoRoot) {
  return {
    worklab: { command: join(repoRoot, "src/mcp/launch-worklab-mcp.sh") },
  };
}

/**
 * Filter a servers map by an allowlist of names.
 * Empty allowlist returns all servers.
 * @param {Record<string, object>} allServers
 * @param {string[]} allowlist
 * @returns {Record<string, object>}
 */
export function pickMcpServers(allServers, allowlist) {
  if (!allowlist || allowlist.length === 0) return { ...allServers };
  const out = {};
  for (const name of allowlist) {
    if (allServers[name]) out[name] = allServers[name];
  }
  return out;
}
