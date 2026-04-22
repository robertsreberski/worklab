import { describe, it, expect, vi } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("agents CRUD", () => {
  it("GET /api/agents returns []", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/agents").expect(200);
    expect(res.body).toEqual({ agents: [] });
  });

  it("POST /api/agents creates with required fields", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" }).expect(201);
    expect(res.body.agent.name).toBe("coder");
    expect(res.body.agent.enabled).toBe(true);
    expect(res.body.agent.effort).toBe("medium");
  });

  it("POST rejects missing fields", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "x" }).expect(400);
  });

  it("POST rejects legacy tier model aliases", async () => {
    const { agent } = makeTestServer();
    const bare = await agent.post("/api/agents").send({ name: "bare", display_name: "Bare", sdk: "claude", model: "sonnet" }).expect(400);
    expect(bare.body.error.code).toBe("invalid_model");

    const prefixed = await agent.post("/api/agents").send({ name: "prefixed", display_name: "Prefixed", sdk: "claude", model: "claude:sonnet" }).expect(400);
    expect(prefixed.body.error.code).toBe("invalid_model");
  });

  it("POST rejects invalid name (must be slug)", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "Has Spaces", display_name: "x", sdk: "claude", model: "claude:claude-sonnet-4-6" }).expect(400);
  });

  it("POST rejects duplicate name", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "dup", display_name: "X", sdk: "claude", model: "claude:claude-sonnet-4-6" });
    await agent.post("/api/agents").send({ name: "dup", display_name: "Y", sdk: "claude", model: "claude:claude-sonnet-4-6" }).expect(409);
  });

  it("GET /api/agents/:name returns single with parsed JSON allowlists", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });
    const res = await agent.get("/api/agents/coder").expect(200);
    expect(res.body.agent.skills_allowlist).toEqual([]);
    expect(res.body.agent.mcp_allowlist).toEqual([]);
    expect(res.body.agent.builtin_allowlist).toEqual([]);
  });

  it("PATCH updates fields including allowlists (arrays)", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });
    const res = await agent.patch("/api/agents/coder").send({ instructions: "new", skills_allowlist: ["example"] }).expect(200);
    expect(res.body.agent.instructions).toBe("new");
    expect(res.body.agent.skills_allowlist).toEqual(["example"]);
  });

  it("PATCH derives sdk from explicit model refs and rejects tier aliases", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });

    const updated = await agent.patch("/api/agents/coder").send({ sdk: "claude", model: "openai:gpt-5.4-mini" }).expect(200);
    expect(updated.body.agent.sdk).toBe("openai");
    expect(updated.body.agent.model).toBe("openai:gpt-5.4-mini");

    const rejected = await agent.patch("/api/agents/coder").send({ model: "openai:opus" }).expect(400);
    expect(rejected.body.error.code).toBe("invalid_model");
  });

  it("DELETE removes agent", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "claude:claude-sonnet-4-6" });
    await agent.delete("/api/agents/coder").expect(204);
    await agent.get("/api/agents/coder").expect(404);
  });

  it("POST /api/agents/:name/consolidate delegates to consolidation manager", async () => {
    const consolidation = { runNow: vi.fn(() => ({ runId: "run_123" })) };
    const { agent } = makeTestServer({ consolidation });
    const res = await agent.post("/api/agents/coder/consolidate").expect(200);
    expect(consolidation.runNow).toHaveBeenCalledWith("coder", { force: true });
    expect(res.body).toEqual({ runId: "run_123" });
  });
});
