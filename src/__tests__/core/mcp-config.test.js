import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, pickMcpServers, getBuiltinMcpServers } from "../../core/mcp-config.js";

describe("loadMcpConfig", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function mk(contents) {
    const d = mkdtempSync(join(tmpdir(), "worklab-mcp-"));
    dirs.push(d);
    mkdirSync(join(d, "config"));
    writeFileSync(join(d, "config", "mcp.json"), JSON.stringify(contents));
    return d;
  }

  it("returns {} if mcp.json missing", () => {
    const d = mkdtempSync(join(tmpdir(), "worklab-mcp-empty-")); dirs.push(d);
    expect(loadMcpConfig(d)).toEqual({});
  });

  it("loads stdio server with absolute command path", () => {
    const d = mk({ mcpServers: { s: { command: "/usr/bin/node", args: ["x"] } } });
    expect(loadMcpConfig(d).s).toEqual({ command: "/usr/bin/node", args: ["x"] });
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
  it("returns worklab entry with absolute launcher path", () => {
    const r = getBuiltinMcpServers("/repo/root");
    expect(r.worklab.command).toBe("/repo/root/src/mcp/launch-worklab-mcp.sh");
  });
});
