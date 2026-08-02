import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { spawnTaskRun } from "../../coordinator/watcher/spawn-run.js";
import { makeTestDb } from "../helpers/test-db.js";
import { newTaskId } from "../../core/ids.js";

function setup(db, dataDir, { withProfile = true } = {}) {
  const now = Date.now();
  const taskId = newTaskId();
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(taskId, "External task", now, now);
  db.prepare(`INSERT INTO agents
    (name, display_name, sdk, model, execution_mode, created_at, updated_at)
    VALUES ('external', 'External', 'acp', 'acp:profile-1', 'acp', ?, ?)`)
    .run(now, now);
  if (withProfile) {
    db.prepare(`INSERT INTO acp_profiles
      (id, agent_name, driver, command, args_json, cwd, env_keys_json,
       configuration_owner, workspace_owner, mcp_owner, created_at, updated_at)
      VALUES ('profile-1', 'external', 'generic', '/bin/sh', '[]', ?, '[]',
              'client', 'client', 'client', ?, ?)`)
      .run(dataDir, now, now);
  }
  return db.prepare("SELECT id, title, stage FROM tasks WHERE id = ?").get(taskId);
}

function runOptions({ db, dataDir, task, spawn }) {
  return {
    db,
    broker: { broadcast: () => {} },
    spawn,
    workerBinary: "/bin/true",
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    repoRoot: dataDir,
    dataDir,
    workspace: dataDir,
    runTimeoutMs: 60_000,
    runIdleWarningMs: 0,
    logInlineLimit: 0,
    active: new Map(),
    activeByRunId: new Map(),
    onWorkerExit: () => {},
    task,
    stage: "execute",
    mode: "execute",
    agentName: "external",
  };
}

describe("spawnTaskRun ACP preflight", () => {
  it("persists ACP provider identity and forwards the validated profile id", () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-spawn-"));
    try {
      const task = setup(db, dataDir);
      let spawned;
      const { runId } = spawnTaskRun(runOptions({
        db,
        dataDir,
        task,
        spawn: (options) => {
          spawned = options;
          return { pid: 123, done: new Promise(() => {}) };
        },
      }));
      expect(spawned.env.WORKLAB_ACP_PROFILE_ID).toBe("profile-1");
      expect(db.prepare("SELECT provider_kind FROM task_runs WHERE id = ?").get(runId))
        .toEqual({ provider_kind: "acp" });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails before inserting a run when the profile binding is missing", () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-spawn-"));
    try {
      const task = setup(db, dataDir, { withProfile: false });
      expect(() => spawnTaskRun(runOptions({
        db,
        dataDir,
        task,
        spawn: () => { throw new Error("must not spawn"); },
      }))).toThrow(/not bound/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM task_runs").get().count).toBe(0);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
