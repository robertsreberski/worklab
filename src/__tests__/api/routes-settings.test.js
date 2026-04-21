import { describe, it, expect } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("settings", () => {
  it("GET returns defaults when empty", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/settings").expect(200);
    expect(res.body.settings.consolidation_hour).toBe(3);
    expect(res.body.settings.consolidation_enabled).toBe(true);
    expect(res.body.settings.worker_timeout_ms).toBe(1800000);
  });

  it("PATCH writes and GET reads back", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({ consolidation_hour: 5 }).expect(200);
    const res = await agent.get("/api/settings").expect(200);
    expect(res.body.settings.consolidation_hour).toBe(5);
  });

  it("PATCH rejects unknown keys", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({ bogus: 1 }).expect(400);
  });
});
