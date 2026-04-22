import { describe, it, expect } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("agents CRUD", () => {
  it("GET /api/agents returns []", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/agents").expect(200);
    expect(res.body).toEqual({ agents: [] });
  });

  it("POST /api/agents creates with required fields", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "sonnet" }).expect(201);
    expect(res.body.agent.name).toBe("coder");
    expect(res.body.agent.enabled).toBe(true);
    expect(res.body.agent.effort).toBe("medium");
  });

  it("POST rejects missing fields", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "x" }).expect(400);
  });

  it("POST rejects invalid name (must be slug)", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "Has Spaces", display_name: "x", sdk: "claude", model: "sonnet" }).expect(400);
  });

  it("POST rejects duplicate name", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "dup", display_name: "X", sdk: "claude", model: "sonnet" });
    await agent.post("/api/agents").send({ name: "dup", display_name: "Y", sdk: "claude", model: "sonnet" }).expect(409);
  });

  it("GET /api/agents/:name returns single with parsed JSON allowlists", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "sonnet" });
    const res = await agent.get("/api/agents/coder").expect(200);
    expect(res.body.agent.skills_allowlist).toEqual([]);
    expect(res.body.agent.mcp_allowlist).toEqual([]);
    expect(res.body.agent.builtin_allowlist).toEqual([]);
  });

  it("PATCH updates fields including allowlists (arrays)", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "sonnet" });
    const res = await agent.patch("/api/agents/coder").send({ instructions: "new", skills_allowlist: ["example"] }).expect(200);
    expect(res.body.agent.instructions).toBe("new");
    expect(res.body.agent.skills_allowlist).toEqual(["example"]);
  });

  it("DELETE removes agent", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "sonnet" });
    await agent.delete("/api/agents/coder").expect(204);
    await agent.get("/api/agents/coder").expect(404);
  });
});
