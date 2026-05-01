import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_MCP_HEALTH_TIMEOUT_MS = 5000;

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

function rawUserMcpServers(dataDir) {
  const p = join(dataDir, "config", "mcp.json");
  if (!existsSync(p)) return { servers: {}, config_error: null };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return { servers: raw.mcpServers || {}, config_error: null };
  } catch (err) {
    return { servers: {}, config_error: err.message || String(err) };
  }
}

function resolveMcpHealthCwd(config = {}, cwd = null) {
  const configured = config.cwd || null;
  if (configured && isAbsolute(configured)) return configured;
  if (configured) return resolve(cwd || process.cwd(), configured);
  return cwd || process.cwd();
}

function withTimeout(promiseFactory, timeoutMs, label) {
  const ms = Number(timeoutMs) || DEFAULT_MCP_HEALTH_TIMEOUT_MS;
  let timeout;
  const task = Promise.resolve().then(promiseFactory);
  task.catch(() => {});
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([task, timer]).finally(() => clearTimeout(timeout));
}

async function listMcpToolsForHealth(name, config, { cwd, timeoutMs }) {
  const client = new McpClient({ name: `worklab-health/${name}`, version: "0.1.0" }, { capabilities: {} });
  let transport;
  try {
    if (config.type === "http") {
      transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers || {} } });
    } else if (config.type === "sse") {
      transport = new SSEClientTransport(new URL(config.url), {
        eventSourceInit: { headers: config.headers || {} },
        requestInit: { headers: config.headers || {} },
      });
    } else {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        cwd: resolveMcpHealthCwd(config, cwd),
        env: { ...process.env, ...(config.env || {}) },
      });
    }
    return await withTimeout(async () => {
      await client.connect(transport);
      return client.listTools();
    }, timeoutMs, `${name} health check`);
  } finally {
    try { await client.close?.(); } catch {}
    try { await transport?.close?.(); } catch {}
  }
}

export async function checkMcpServerHealth(name, rawConfig, {
  source = "draft",
  timeoutMs = DEFAULT_MCP_HEALTH_TIMEOUT_MS,
  cwd = null,
} = {}) {
  const started = Date.now();
  const staticStatus = statusForServer({ name, source, rawConfig });
  const base = {
    name,
    source,
    transport: staticStatus.transport,
    static_available: staticStatus.available !== false,
  };
  if (staticStatus.available === false) {
    return {
      ...base,
      health: "error",
      message: staticStatus.unavailable_reason || "MCP server unavailable",
      duration_ms: Date.now() - started,
      tool_count: 0,
      tools_preview: [],
    };
  }

  try {
    const listed = await listMcpToolsForHealth(name, staticStatus.config, { cwd, timeoutMs });
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    const toolNames = tools.map((tool) => tool.name).filter(Boolean);
    return {
      ...base,
      health: "ok",
      message: toolNames.length ? `${toolNames.length} tools available` : "Connected; no tools reported",
      duration_ms: Date.now() - started,
      tool_count: toolNames.length,
      tools_preview: toolNames.slice(0, 5),
    };
  } catch (err) {
    return {
      ...base,
      health: "error",
      message: err.message || String(err),
      duration_ms: Date.now() - started,
      tool_count: 0,
      tools_preview: [],
    };
  }
}

export async function getMcpServerHealth(dataDir, {
  repoRoot = process.cwd(),
  includeBuiltins = true,
  mcpServers,
  names,
  timeoutMs = DEFAULT_MCP_HEALTH_TIMEOUT_MS,
  cwd = null,
} = {}) {
  const selected = Array.isArray(names) && names.length
    ? new Set(names.map((name) => String(name)).filter(Boolean))
    : null;
  const hasDraftServers = mcpServers !== undefined;
  const entries = [];

  if (includeBuiltins) {
    for (const [name, config] of Object.entries(getBuiltinMcpServers(repoRoot))) {
      const healthConfig = name === "worklab"
        ? {
            ...config,
            env: {
              ...(config.env || {}),
              WORKLAB_DATA_DIR: dataDir,
              WORKLAB_AGENT_NAME: "health-check",
              WORKLAB_RUN_ID: "health-check",
              WORKLAB_TASK_ID: "health-check",
              WORKLAB_TASK_TITLE: "MCP health check",
            },
          }
        : config;
      if (!selected || selected.has(name)) entries.push([name, "builtin", healthConfig]);
    }
  }

  const user = hasDraftServers
    ? { servers: mcpServers || {}, config_error: null, source: "draft" }
    : { ...rawUserMcpServers(dataDir), source: "user" };
  if (user.config_error) {
    return { checked_at: new Date().toISOString(), config_error: user.config_error, results: [] };
  }

  for (const [name, config] of Object.entries(user.servers || {})) {
    if (!selected || selected.has(name)) entries.push([name, user.source, config]);
  }

  const results = await Promise.all(
    entries.map(([name, source, config]) => checkMcpServerHealth(name, config, { source, timeoutMs, cwd })),
  );
  return { checked_at: new Date().toISOString(), config_error: null, results };
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
