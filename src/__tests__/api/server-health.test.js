import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../core/db/schema/current.js";
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

describe("GET /api/services/status", () => {
  it("reports optional service status without changing core health", async () => {
    const { agent } = makeTestServer({
      serviceStatus: () => ({
        optional_services: { started: true },
        services: {
          searchIndexer: { started: true },
          slack: { enabled: true, connected: false, reason: "not_configured" },
        },
      }),
    });

    const res = await agent.get("/api/services/status").expect(200);

    expect(res.body).toMatchObject({
      ok: true,
      optional_services: { started: true },
      services: {
        searchIndexer: { started: true },
        slack: { enabled: true, connected: false, reason: "not_configured" },
      },
    });
  });
});
