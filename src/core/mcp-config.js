import { accessSync, constants, existsSync, readFileSync } from "node:fs";
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

export function validateMcpServerConfig(name, config) {
  if (config?.type === "http" || config?.type === "sse") return validateRemote(name, config);
  return validateStdio(name, config);
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
    out[name] = validateMcpServerConfig(name, cfg);
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

function executableReason(command) {
  if (!command) return "command missing";
  if (!isAbsolute(command)) return `command must be absolute path: ${command}`;
  try {
    accessSync(command, constants.X_OK);
    return null;
  } catch {
    return `command is not executable or not found: ${command}`;
  }
}

function statusForServer({ name, source, rawConfig }) {
  try {
    const config = validateMcpServerConfig(name, rawConfig);
    const reason = config.command ? executableReason(config.command) : null;
    return {
      name,
      source,
      transport: config.type || "stdio",
      available: !reason,
      unavailable_reason: reason,
      config,
    };
  } catch (err) {
    return {
      name,
      source,
      transport: rawConfig?.type || "stdio",
      available: false,
      unavailable_reason: err.message || String(err),
      config: rawConfig || {},
    };
  }
}

export function getMcpServerStatuses(dataDir, { repoRoot = process.cwd() } = {}) {
  const servers = [];
  for (const [name, config] of Object.entries(getBuiltinMcpServers(repoRoot))) {
    servers.push(statusForServer({ name, source: "builtin", rawConfig: config }));
  }

  const p = join(dataDir, "config", "mcp.json");
  if (!existsSync(p)) return { servers, config_error: null };

  let raw;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return { servers, config_error: err.message || String(err) };
  }

  for (const [name, config] of Object.entries(raw.mcpServers || {})) {
    servers.push(statusForServer({ name, source: "user", rawConfig: config }));
  }
  return { servers, config_error: null };
}

export function getAvailableMcpServers(dataDir, { repoRoot = process.cwd() } = {}) {
  const status = getMcpServerStatuses(dataDir, { repoRoot });
  return Object.fromEntries(
    (status.servers || [])
      .filter((server) => server.available !== false)
      .map((server) => [server.name, server.config]),
  );
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
