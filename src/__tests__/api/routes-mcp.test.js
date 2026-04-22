import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { makeTestDb } from "../helpers/test-db.js";
import { createServer } from "../../api/server.js";

describe("mcp config", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
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

  it("PUT rejects non-absolute stdio command", async () => {
    const { agent } = mkServer();
    await agent.put("/api/mcp").send({ mcpServers: { bad: { command: "node" } } }).expect(400);
  });

  it("PUT rejects public http URL", async () => {
    const { agent } = mkServer();
    await agent.put("/api/mcp").send({ mcpServers: { bad: { type: "http", url: "https://example.com" } } }).expect(400);
  });
});
