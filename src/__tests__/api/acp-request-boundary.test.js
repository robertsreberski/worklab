import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import supertest from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApiMutationBoundary } from "../../api/acp-request-boundary.js";
import { readMcpToken } from "../../core/service-token.js";

const cleanup = [];
const ACTIVE_READ_PATHS = [
  "/api/acp/discovery/mono",
  "/api/assistant",
  "/api/assistant/messages",
  "/api/goals",
  "/api/goals/goal-1",
  "/api/models/available",
  "/api/models/opencode?refresh=1",
  "/api/notifications/status",
  "/api/projects/project-1",
  "/api/search?q=boundary",
  "/api/search/embedding-test",
  "/api/settings/runtime",
  "/api/teams/team-1",
  "/api/teams/team-1/goals",
  "/api/update?refresh=true",
];

afterEach(async () => {
  for (const { dataDir, server } of cleanup.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function makeBoundaryServer() {
  const dataDir = mkdtempSync(join(tmpdir(), "worklab-api-boundary-"));
  const app = express();
  app.use("/api", createApiMutationBoundary({
    dataDir,
    config: { host: "127.0.0.1" },
    env: {},
  }));
  app.use("/api", (_req, res) => res.status(204).end());
  const server = createHttpServer(app);
  server.listen(0);
  server.unref();
  cleanup.push({ dataDir, server });
  return {
    agent: supertest(server),
    token: readMcpToken(dataDir),
  };
}

function evilRequest(request) {
  return request
    .set("origin", "https://evil.example")
    .set("sec-fetch-site", "cross-site");
}

function sameUiRequest(request) {
  return request
    .set("host", "127.0.0.1:7878")
    .set("origin", "http://127.0.0.1:7878")
    .set("sec-fetch-site", "same-origin");
}

describe("API mutation boundary active reads", () => {
  it("rejects cross-site GET and HEAD requests for every effectful read path", async () => {
    const { agent } = makeBoundaryServer();

    for (const path of ACTIVE_READ_PATHS) {
      await evilRequest(agent.get(path)).expect(403);
      await evilRequest(agent.head(path)).expect(403);
    }
  });

  it("accepts effectful reads from the same UI or with the service token", async () => {
    const { agent, token } = makeBoundaryServer();

    for (const path of ACTIVE_READ_PATHS) {
      const uiResponse = await sameUiRequest(agent.get(path));
      expect(uiResponse.status, `same-UI request for ${path}`).toBe(204);
      const serviceResponse = await agent.get(path)
        .set("authorization", `Bearer ${token}`);
      expect(serviceResponse.status, `service-token request for ${path}`).toBe(204);
    }
  });

  it("keeps passive reads and SSE paths available without mutation credentials", async () => {
    const { agent } = makeBoundaryServer();

    for (const path of [
      "/api/agents",
      "/api/assistant/runs/run-1",
      "/api/events/stream",
      "/api/models/embeddings",
      "/api/projects",
      "/api/search/status",
      "/api/teams",
      "/api/teams/team-1/cycles",
    ]) {
      const response = await evilRequest(agent.get(path)).expect(204);
      expect(response.headers).not.toHaveProperty("access-control-allow-origin");
    }
  });
});
