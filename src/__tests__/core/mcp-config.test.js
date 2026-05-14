import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkMcpServerHealth,
  getAvailableMcpServers,
  getBuiltinMcpServers,
  getMcpServerHealth,
  loadMcpConfig,
  pickMcpServers,
} from "../../core/mcp-config.js";

const dirs = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

function mk(contents) {
  const d = mkdtempSync(join(tmpdir(), "worklab-mcp-"));
  dirs.push(d);
  mkdirSync(join(d, "config"));
  writeFileSync(join(d, "config", "mcp.json"), JSON.stringify(contents));
  return d;
}

function writeToolServerScript(dir) {
  const script = join(dir, "tool-server.mjs");
  const sdkRoot = join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  writeFileSync(script, `
import { Server } from "${pathToFileURL(join(sdkRoot, "server", "index.js")).href}";
import { StdioServerTransport } from "${pathToFileURL(join(sdkRoot, "server", "stdio.js")).href}";
import { ListToolsRequestSchema } from "${pathToFileURL(join(sdkRoot, "types.js")).href}";

const server = new Server({ name: "test-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
}));
await server.connect(new StdioServerTransport());
`);
  return script;
}

describe("loadMcpConfig", () => {
  it("returns {} if mcp.json missing", () => {
    const d = mkdtempSync(join(tmpdir(), "worklab-mcp-empty-")); dirs.push(d);
    expect(loadMcpConfig(d)).toEqual({});
  });

  it("loads stdio server with absolute command path", () => {
    const d = mk({ mcpServers: { s: { command: "/usr/bin/node", args: ["x"] } } });
    expect(loadMcpConfig(d).s).toEqual({ command: "/usr/bin/node", args: ["x"] });
  });

  it("preserves stdio cwd for workspace-relative MCP servers", () => {
    const d = mk({ mcpServers: { s: { command: "/usr/bin/node", args: ["x"], cwd: "." } } });
    expect(loadMcpConfig(d).s).toEqual({ command: "/usr/bin/node", args: ["x"], cwd: "." });
  });

  it("rejects stdio server with relative command path", () => {
    const d = mk({ mcpServers: { s: { command: "node" } } });
    expect(() => loadMcpConfig(d)).toThrow(/absolute path/i);
  });

  it("loads http server with allowed URL (localhost)", () => {
    const d = mk({ mcpServers: { s: { type: "http", url: "http://localhost:8000" } } });
    expect(loadMcpConfig(d).s.url).toBe("http://localhost:8000");
  });

  it("rejects http server with public URL", () => {
    const d = mk({ mcpServers: { s: { type: "http", url: "https://example.com" } } });
    expect(() => loadMcpConfig(d)).toThrow(/allowlist/i);
  });

  it("allows tailscale CGNAT (100.64/10)", () => {
    const d = mk({ mcpServers: { s: { type: "http", url: "http://100.70.1.5:8080" } } });
    expect(loadMcpConfig(d).s.url).toContain("100.70.1.5");
  });
});

describe("pickMcpServers", () => {
  it("empty allowlist returns all registered", () => {
    const all = { a: { command: "/a" }, b: { command: "/b" } };
    expect(pickMcpServers(all, [])).toEqual(all);
  });

  it("allowlist filters", () => {
    const all = { a: { command: "/a" }, b: { command: "/b" } };
    expect(pickMcpServers(all, ["a"])).toEqual({ a: { command: "/a" } });
  });
});

describe("getBuiltinMcpServers", () => {
  it("returns worklab and webhooks entries with absolute launchers", () => {
    const r = getBuiltinMcpServers("/repo/root");
    expect(r.worklab.command).toBe("/repo/root/src/mcp/launch-worklab-mcp.sh");
    expect(r.webhooks.command).toBe(process.execPath);
    expect(r.webhooks.args[0]).toMatch(/webhooks.+server\.js$/);
  });
});

describe("getAvailableMcpServers", () => {
  it("filters unavailable user stdio commands while keeping built-ins", () => {
    const d = mk({ mcpServers: {
      missing: { command: "/definitely/not/worklab-mcp" },
      node: { command: process.execPath },
    } });
    const available = getAvailableMcpServers(d, { repoRoot: process.cwd() });
    expect(available.worklab).toBeTruthy();
    expect(available.webhooks).toBeTruthy();
    expect(available.node.command).toBe(process.execPath);
    expect(available.missing).toBeUndefined();
  });
});

describe("MCP health checks", () => {
  it("reports validation failures without starting a server", async () => {
    const result = await checkMcpServerHealth("bad", { command: "node" }, { timeoutMs: 100 });
    expect(result).toMatchObject({
      name: "bad",
      health: "error",
      static_available: false,
    });
    expect(result.message).toMatch(/absolute path/i);
  });

  it("reports missing stdio executables", async () => {
    const result = await checkMcpServerHealth("missing", { command: "/definitely/not/worklab-mcp" }, { timeoutMs: 100 });
    expect(result.health).toBe("error");
    expect(result.static_available).toBe(false);
    expect(result.message).toMatch(/not executable|not found/i);
  });

  it("connects to stdio servers and lists tools", async () => {
    const d = mk({ mcpServers: {} });
    const script = writeToolServerScript(d);
    const result = await checkMcpServerHealth("tools", { command: process.execPath, args: [script] }, { timeoutMs: 2000, cwd: d });
    expect(result).toMatchObject({
      health: "ok",
      static_available: true,
      tool_count: 1,
    });
    expect(result.tools_preview).toContain("ping");
  });

  it("times out hung servers and returns promptly", async () => {
    const d = mk({ mcpServers: {} });
    const script = join(d, "hung-server.mjs");
    writeFileSync(script, "setInterval(() => {}, 1000);");
    const result = await checkMcpServerHealth("hung", { command: process.execPath, args: [script] }, { timeoutMs: 100, cwd: d });
    expect(result.health).toBe("error");
    expect(result.message).toMatch(/timed out/i);
    expect(result.duration_ms).toBeLessThan(3000);
  });

  it("checks saved user servers and includes checked_at", async () => {
    const d = mk({ mcpServers: { missing: { command: "/definitely/not/worklab-mcp" } } });
    const response = await getMcpServerHealth(d, { includeBuiltins: false, timeoutMs: 100 });
    expect(response.checked_at).toMatch(/T/);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({ name: "missing", source: "user", health: "error" });
  });

  it("lists tools from the built-in webhook server", async () => {
    const d = mk({ mcpServers: {} });
    const response = await getMcpServerHealth(d, {
      repoRoot: process.cwd(),
      names: ["webhooks"],
      timeoutMs: 2000,
    });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      name: "webhooks",
      source: "builtin",
      health: "ok",
      static_available: true,
    });
    expect(response.results[0].tools_preview).toContain("trigger_webhook");
  });
});
