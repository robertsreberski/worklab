import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../core/schema.js";
import { makeTestServer } from "../helpers/test-server.js";

describe("GET /api/health", () => {
  it("reports schema and route readiness", async () => {
    const { agent } = makeTestServer();

    const res = await agent.get("/api/health").expect(200);

    expect(res.body).toMatchObject({
      ok: true,
      schema: {
        expected: SCHEMA_VERSION,
        actual: String(SCHEMA_VERSION),
      },
      routes: {
        projects: true,
      },
    });
    expect(res.body.pid).toBeGreaterThan(0);
  });
});
