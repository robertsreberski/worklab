import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "../../core/db/schema/current.js";
import {
  coordinatorIncarnationDigest,
  coordinatorShutdownProof,
  ensureMcpToken,
} from "../../core/index.js";
import { makeTestServer } from "../helpers/test-server.js";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  it("exposes only a digest for the active coordinator incarnation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-health-control-"));
    tempDirs.push(dataDir);
    const incarnation = "health-control-incarnation";
    const { agent } = makeTestServer({
      dataDir,
      coordinatorControl: { incarnation, requestShutdown: vi.fn() },
    });

    const res = await agent.get("/api/health").expect(200);

    expect(res.body.coordinator).toEqual({
      claim_format: "v2",
      incarnation_sha256: coordinatorIncarnationDigest(incarnation),
    });
    expect(JSON.stringify(res.body)).not.toContain(incarnation);
    expect(JSON.stringify(res.body)).not.toContain(ensureMcpToken(dataDir));
  });

  it("accepts only an incarnation-scoped shutdown proof and responds before shutdown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-shutdown-control-"));
    tempDirs.push(dataDir);
    const incarnation = "shutdown-control-incarnation";
    const requestShutdown = vi.fn(async () => {});
    const { rawAgent } = makeTestServer({
      dataDir,
      coordinatorControl: { incarnation, requestShutdown },
    });
    const proof = coordinatorShutdownProof(ensureMcpToken(dataDir), incarnation);

    await rawAgent
      .post("/api/runtime/shutdown")
      .set("x-worklab-coordinator-shutdown-proof", "0".repeat(64))
      .expect(409);
    expect(requestShutdown).not.toHaveBeenCalled();

    await rawAgent
      .post("/api/runtime/shutdown")
      .set("x-worklab-coordinator-shutdown-proof", proof)
      .expect(202, { ok: true, pid: process.pid });
    await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledTimes(1));

    await rawAgent
      .post("/api/runtime/shutdown")
      .set("x-worklab-coordinator-shutdown-proof", proof)
      .expect(202);
    expect(requestShutdown).toHaveBeenCalledTimes(1);
  });
});

describe("API caching headers", () => {
  it("marks /api responses as no-store so SW and browser caches stay out of the way", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/health").expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
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
