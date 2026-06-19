import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import supertest from "supertest";
import { makeTestDb } from "../helpers/test-db.js";
import { createServer } from "../../api/server.js";

describe("mcp config", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function writeToolServerScript(dir) {
    const script = join(dir, "tool-server.mjs");
    const sdkRoot = join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
    writeFileSync(script, `
import { Server } from "${pathToFileURL(join(sdkRoot, "server", "index.js")).href}";
import { StdioServerTransport } from "${pathToFileURL(join(sdkRoot, "server", "stdio.js")).href}";
import { ListToolsRequestSchema } from "${pathToFileURL(join(sdkRoot, "types.js")).href}";

const server = new Server({ name: "route-test-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "route_ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
}));
await server.connect(new StdioServerTransport());
`);
    return script;
  }

  function mkServer() {
    const d = mkdtempSync(join(tmpdir(), "worklab-mcp-route-")); dirs.push(d);
    mkdirSync(join(d, "config"));
    writeFileSync(join(d, "config/mcp.json"), JSON.stringify({ mcpServers: {} }));
    const db = makeTestDb();
    const { app } = createServer({ db, logger: undefined, watcher: undefined, dataDir: d });
    return { agent: supertest(app), dataDir: d };
  }

  it("GET returns empty mcpServers when default", async () => {
    const { agent } = mkServer();
    const res = await agent.get("/api/mcp").expect(200);
    expect(res.body).toEqual({ mcpServers: {} });
  });

  it("PUT writes to disk and round-trips", async () => {
    const { agent, dataDir } = mkServer();
    const payload = { mcpServers: { slack: { command: "/usr/bin/node", args: ["/opt/slack-mcp"] } } };
    await agent.put("/api/mcp").send(payload).expect(200);
    const content = JSON.parse(readFileSync(join(dataDir, "config/mcp.json"), "utf8"));
    expect(content.mcpServers.slack.command).toBe("/usr/bin/node");
    const res = await agent.get("/api/mcp").expect(200);
    expect(res.body.mcpServers.slack.command).toBe("/usr/bin/node");
  });

  it("PUT preserves disabled MCP servers and status marks them disabled", async () => {
    const { agent, dataDir } = mkServer();
    const payload = {
      mcpServers: {
        apple: { type: "http", url: "http://127.0.0.1:7501/mcp", enabled: false },
      },
    };

    await agent.put("/api/mcp").send(payload).expect(200);
    const content = JSON.parse(readFileSync(join(dataDir, "config/mcp.json"), "utf8"));
    expect(content.mcpServers.apple.enabled).toBe(false);

    const config = await agent.get("/api/mcp").expect(200);
    expect(config.body.mcpServers.apple).toMatchObject(payload.mcpServers.apple);

    const status = await agent.get("/api/mcp/status").expect(200);
    expect(status.body.servers.find((server) => server.name === "apple")).toMatchObject({
      source: "user",
      available: false,
      disabled: true,
      unavailable_reason: "disabled",
    });
  });

  it("PUT rejects non-absolute stdio command", async () => {
    const { agent } = mkServer();
    await agent.put("/api/mcp").send({ mcpServers: { bad: { command: "node" } } }).expect(400);
  });

  it("PUT rejects public http URL", async () => {
    const { agent } = mkServer();
    await agent.put("/api/mcp").send({ mcpServers: { bad: { type: "http", url: "https://example.com" } } }).expect(400);
  });

  it("GET /api/mcp/status includes built-in and user availability", async () => {
    const { agent } = mkServer();
    await agent.put("/api/mcp").send({
      mcpServers: {
        node_tools: { command: process.execPath, args: ["server.js"] },
      },
    }).expect(200);

    const res = await agent.get("/api/mcp/status").expect(200);
    const names = res.body.servers.map((server) => server.name);
    expect(names).toContain("worklab");
    expect(names).toContain("node_tools");
    expect(res.body.servers.find((server) => server.name === "worklab")).toMatchObject({
      source: "builtin",
      available: true,
    });
  });

  it("POST /api/mcp/health probes draft servers without saving them", async () => {
    const { agent, dataDir } = mkServer();
    const script = writeToolServerScript(dataDir);
    const res = await agent.post("/api/mcp/health").send({
      includeBuiltins: false,
      mcpServers: {
        draft_tools: { command: process.execPath, args: [script] },
      },
      names: ["draft_tools"],
    }).expect(200);

    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      name: "draft_tools",
      source: "draft",
      health: "ok",
      tool_count: 1,
    });
    expect(res.body.results[0].tools_preview).toContain("route_ping");
    const saved = await agent.get("/api/mcp").expect(200);
    expect(saved.body.mcpServers).toEqual({});
  });

  it("POST /api/mcp/health validates request shape", async () => {
    const { agent } = mkServer();
    await agent.post("/api/mcp/health").send({ mcpServers: [] }).expect(400);
    await agent.post("/api/mcp/health").send({ names: "worklab" }).expect(400);
  });

  it("protects the admin MCP endpoint with the local token", async () => {
    const d = mkdtempSync(join(tmpdir(), "worklab-admin-mcp-route-")); dirs.push(d);
    mkdirSync(join(d, "config"));
    writeFileSync(join(d, "config/mcp.json"), JSON.stringify({ mcpServers: {} }));
    const db = makeTestDb();
    const config = {
      host: "127.0.0.1",
      port: 7878,
      dataDir: d,
      workspace: d,
      repoRoot: process.cwd(),
      logLevel: "error",
    };
    const { app } = createServer({ db, logger: undefined, watcher: undefined, dataDir: d, config });
    const agent = supertest(app);

    await agent.get("/mcp").expect(401);
    const token = readFileSync(join(d, "mcp-token"), "utf8").trim();
    await agent.get("/mcp").set("authorization", `Bearer ${token}`).expect(405);
  });
});
