import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import supertest from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApiMutationBoundary } from "../../api/acp-request-boundary.js";
import { readMcpToken } from "../../core/service-token.js";
import { makeTestServer } from "../helpers/test-server.js";

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
  "/api/runs/run-1",
  "/api/search?q=boundary",
  "/api/search/embedding-test",
  "/api/settings/runtime",
  "/api/tasks/task-1",
  "/api/tasks/task-1/run-preview",
  "/api/tasks/task-1/runs",
  "/api/tasks/task-1/runs?view=full",
  "/api/files/read?task_id=task-1&path=README.md",
  "/api/files/suggest?task=task-1&prefix=src",
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

function seedGitBackedTaskReadFixture(db, workdir) {
  const now = Date.now();
  const taskId = "task-effectful-read";
  const blockerId = "task-effectful-blocker";
  const runId = "run-effectful-read";
  const worktree = JSON.stringify({
    source_git_root: workdir,
    source_head_before: "before-head",
    source_head_after: "after-head",
  });
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at)
    VALUES ('effectful-reader', 'Effectful Reader', 'claude', 'claude:claude-sonnet-4-6', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO tasks (id, title, stage, owner_agent, created_at, updated_at)
    VALUES (?, ?, 'execute', 'effectful-reader', ?, ?)
  `).run(taskId, "Effectful read", now, now);
  db.prepare(`
    INSERT INTO tasks (id, title, stage, owner_agent, created_at, updated_at)
    VALUES (?, ?, 'done', 'effectful-reader', ?, ?)
  `).run(blockerId, "Completed blocker", now, now);
  db.prepare(`
    INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
    VALUES (?, ?, ?)
  `).run(taskId, blockerId, now);
  db.prepare(`
    INSERT INTO task_edges
      (parent_task_id, child_task_id, edge_type, required, created_at)
    VALUES (?, ?, 'subtask', 1, ?)
  `).run(taskId, blockerId, now);
  const insertRun = db.prepare(`
    INSERT INTO task_runs
      (id, task_id, mode, stage, agent_name, started_at, ended_at, status,
       process_status, source_workdir, worktree_json)
    VALUES (?, ?, 'execute', 'execute', 'effectful-reader', ?, ?, 'complete',
            'succeeded', ?, ?)
  `);
  insertRun.run(runId, taskId, now - 2, now - 1, workdir, worktree);
  insertRun.run("run-effectful-blocker", blockerId, now - 4, now - 3, workdir, worktree);
  return { taskId, runId };
}

function installRecordingGit(root) {
  const binDir = join(root, "bin");
  const marker = join(root, "git-invocations.log");
  const gitPath = join(binDir, "git");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(gitPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$WORKLAB_TEST_GIT_MARKER"
case "$*" in
  *--numstat*) printf '1\\t0\\tsrc/effectful.js\\n' ;;
  *--name-status*) printf 'M\\tsrc/effectful.js\\n' ;;
esac
`, { mode: 0o755 });
  return { binDir, marker };
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
      const uiHeadResponse = await sameUiRequest(agent.head(path));
      expect(uiHeadResponse.status, `same-UI HEAD request for ${path}`).toBe(204);
      const serviceResponse = await agent.get(path)
        .set("authorization", `Bearer ${token}`);
      expect(serviceResponse.status, `service-token request for ${path}`).toBe(204);
      const serviceHeadResponse = await agent.head(path)
        .set("authorization", `Bearer ${token}`);
      expect(serviceHeadResponse.status, `service-token HEAD request for ${path}`).toBe(204);
    }
  });

  it("keeps passive reads and SSE paths available without mutation credentials", async () => {
    const { agent } = makeBoundaryServer();

    for (const path of [
      "/api/agents",
      "/api/assistant/runs/run-1",
      "/api/events/stream",
      "/api/models/embeddings",
      "/api/files/read?path=README.md",
      "/api/files/suggest?prefix=src",
      "/api/projects",
      "/api/runs/cost-summary",
      "/api/search/status",
      "/api/tasks",
      "/api/tasks?view=summary",
      "/api/tasks/task-1/automations",
      "/api/tasks/task-1/runs?view=summary",
      "/api/teams",
      "/api/teams/team-1/cycles",
    ]) {
      const response = await evilRequest(agent.get(path)).expect(204);
      expect(response.headers).not.toHaveProperty("access-control-allow-origin");
    }
  });

  it("blocks real effectful read routes before git and allows trusted callers", async () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-effectful-read-boundary-"));
    const dataDir = join(root, "data");
    const workdir = join(root, "workspace");
    const previousPath = process.env.PATH;
    const previousMarker = process.env.WORKLAB_TEST_GIT_MARKER;
    try {
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(workdir, { recursive: true });
      const { binDir, marker } = installRecordingGit(root);
      const { agent, rawAgent, db } = makeTestServer({
        dataDir,
        config: { dataDir, host: "127.0.0.1", repoRoot: workdir, workspace: workdir },
      });
      const { taskId, runId } = seedGitBackedTaskReadFixture(db, workdir);
      writeFileSync(join(workdir, "note.txt"), "safe local note\n");
      const token = readMcpToken(dataDir);
      process.env.PATH = binDir;
      process.env.WORKLAB_TEST_GIT_MARKER = marker;

      const activePaths = [
        `/api/runs/${runId}?events=none`,
        `/api/tasks/${taskId}?runs=none`,
        `/api/tasks/${taskId}/runs`,
        `/api/tasks/${taskId}/run-preview`,
        `/api/files/suggest?task_id=${taskId}&prefix=note`,
        `/api/files/read?task=${taskId}&path=note.txt`,
      ];
      for (const path of activePaths) {
        rmSync(marker, { force: true });
        await evilRequest(rawAgent.get(path)).expect(403);
        expect(existsSync(marker), `cross-site request spawned git for ${path}`).toBe(false);

        rmSync(marker, { force: true });
        await evilRequest(rawAgent.head(path)).expect(403);
        expect(existsSync(marker), `cross-site HEAD request spawned git for ${path}`).toBe(false);

        rmSync(marker, { force: true });
        const uiResponse = await agent.get(path);
        expect(uiResponse.status, `same-UI request for ${path}`).toBe(200);
        expect(readFileSync(marker, "utf8"), `same-UI request did not reach git for ${path}`)
          .toContain("diff --numstat");

        rmSync(marker, { force: true });
        const tokenResponse = await rawAgent.get(path)
          .set("authorization", `Bearer ${token}`);
        expect(tokenResponse.status, `service-token request for ${path}`).toBe(200);
        expect(readFileSync(marker, "utf8"), `service-token request did not reach git for ${path}`)
          .toContain("diff --numstat");
      }

      for (const path of [
        `/api/runs/${runId}/approvals`,
        "/api/tasks",
        `/api/tasks/${taskId}/runs?view=summary`,
        "/api/tasks?view=summary",
        "/api/files/suggest?prefix=note",
        "/api/files/read?path=note.txt",
      ]) {
        rmSync(marker, { force: true });
        await evilRequest(rawAgent.get(path)).expect(200);
        expect(existsSync(marker), `passive request spawned git for ${path}`).toBe(false);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.WORKLAB_TEST_GIT_MARKER;
      else process.env.WORKLAB_TEST_GIT_MARKER = previousMarker;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
