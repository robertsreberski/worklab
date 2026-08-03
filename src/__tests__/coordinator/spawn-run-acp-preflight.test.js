import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { spawnTaskRun } from "../../coordinator/watcher/spawn-run.js";
import { structuralAcpProviderSessionId } from "../helpers/acp-tokens.js";
import { makeTestDb } from "../helpers/test-db.js";
import { newRunId, newTaskId } from "../../core/ids.js";

function setup(db, dataDir, {
  withProfile = true,
  project = null,
  profile = {},
} = {}) {
  const now = Date.now();
  const taskId = newTaskId();
  if (project) {
    db.prepare(`
      INSERT INTO projects (id, slug, name, workdir, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      project.id || "project-acp",
      project.slug || "project-acp",
      project.name || "ACP Project",
      project.workdir ?? null,
      now,
      now,
    );
  }
  db.prepare("INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(taskId, project?.id || null, "External task", now, now);
  db.prepare(`INSERT INTO agents
    (name, display_name, sdk, model, execution_mode, created_at, updated_at)
    VALUES ('external', 'External', 'acp', 'acp:profile-1', 'acp', ?, ?)`)
    .run(now, now);
  if (withProfile) {
    db.prepare(`INSERT INTO acp_profiles
      (id, agent_name, driver, command, args_json, cwd, env_keys_json,
       mono_source_id, mono_source_json, configuration_owner, workspace_owner,
       mcp_owner, canonical_workspace, created_at, updated_at)
      VALUES ('profile-1', 'external', ?, '/bin/sh', '[]', ?, '[]', ?, ?,
              ?, ?, ?, ?, ?, ?)`)
      .run(
        profile.driver || "generic",
        profile.cwd || dataDir,
        profile.driver === "mono" ? "mono:external" : null,
        profile.driver === "mono" ? JSON.stringify({ sourceId: "mono:external" }) : "{}",
        profile.configurationOwner || "client",
        profile.workspaceOwner || "client",
        profile.mcpOwner || "client",
        profile.canonicalWorkspace || null,
        now,
        now,
      );
  }
  return db.prepare("SELECT id, project_id, title, stage FROM tasks WHERE id = ?").get(taskId);
}

function runOptions({ db, dataDir, task, spawn, workspace = dataDir, repoRoot = dataDir }) {
  return {
    db,
    broker: { broadcast: () => {} },
    spawn,
    workerBinary: "/bin/true",
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    repoRoot,
    dataDir,
    workspace,
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
  it("uses the canonical agent-owned ACP workspace for a projectless task", () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-spawn-"));
    try {
      const globalWorkspace = join(dataDir, "global-workspace");
      const canonicalWorkspace = join(dataDir, "agent-workspace");
      mkdirSync(globalWorkspace);
      mkdirSync(canonicalWorkspace);
      const resolvedWorkspace = realpathSync(canonicalWorkspace);
      const task = setup(db, dataDir, {
        profile: {
          driver: "mono",
          configurationOwner: "agent",
          workspaceOwner: "agent",
          mcpOwner: "agent",
          canonicalWorkspace,
        },
      });
      let spawned;

      const { runId } = spawnTaskRun(runOptions({
        db,
        dataDir,
        task,
        workspace: globalWorkspace,
        spawn: (options) => {
          spawned = options;
          return { pid: 123, done: new Promise(() => {}) };
        },
      }));

      expect(spawned.env.WORKLAB_WORKSPACE).toBe(resolvedWorkspace);
      expect(spawned.env.WORKLAB_QA_OUTPUT_DIR).toBe(
        join(resolvedWorkspace, ".worklab-tmp", "artifacts", runId),
      );
      expect(db.prepare("SELECT project_id, workdir FROM task_runs WHERE id = ?").get(runId))
        .toEqual({ project_id: null, workdir: resolvedWorkspace });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("uses the canonical agent workspace for a project without a workdir and retains project context", () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-spawn-"));
    try {
      const globalWorkspace = join(dataDir, "global-workspace");
      const canonicalWorkspace = join(dataDir, "agent-workspace");
      mkdirSync(globalWorkspace);
      mkdirSync(canonicalWorkspace);
      const resolvedWorkspace = realpathSync(canonicalWorkspace);
      const task = setup(db, dataDir, {
        project: { id: "project-without-workdir", workdir: null },
        profile: {
          driver: "mono",
          configurationOwner: "agent",
          workspaceOwner: "agent",
          mcpOwner: "agent",
          canonicalWorkspace,
        },
      });
      let spawned;

      const { runId } = spawnTaskRun(runOptions({
        db,
        dataDir,
        task,
        workspace: globalWorkspace,
        spawn: (options) => {
          spawned = options;
          return { pid: 123, done: new Promise(() => {}) };
        },
      }));

      expect(spawned.env).toMatchObject({
        WORKLAB_WORKSPACE: resolvedWorkspace,
        WORKLAB_PROJECT_ID: "project-without-workdir",
      });
      expect(db.prepare("SELECT project_id, workdir FROM task_runs WHERE id = ?").get(runId))
        .toEqual({ project_id: "project-without-workdir", workdir: resolvedWorkspace });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("accepts a canonically matching explicit project workdir", () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-spawn-"));
    try {
      const canonicalWorkspace = join(dataDir, "agent-workspace");
      const projectWorkspace = join(dataDir, "agent-workspace-link");
      mkdirSync(canonicalWorkspace);
      const resolvedWorkspace = realpathSync(canonicalWorkspace);
      symlinkSync(canonicalWorkspace, projectWorkspace);
      const task = setup(db, dataDir, {
        project: { id: "project-matching-workdir", workdir: projectWorkspace },
        profile: {
          driver: "mono",
          configurationOwner: "agent",
          workspaceOwner: "agent",
          mcpOwner: "agent",
          canonicalWorkspace,
        },
      });
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

      expect(spawned.env.WORKLAB_WORKSPACE).toBe(resolvedWorkspace);
      expect(db.prepare("SELECT workdir FROM task_runs WHERE id = ?").get(runId))
        .toEqual({ workdir: resolvedWorkspace });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects an explicit project workdir that differs from the agent-owned workspace", () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-spawn-"));
    try {
      const canonicalWorkspace = join(dataDir, "agent-workspace");
      const projectWorkspace = join(dataDir, "project-workspace");
      mkdirSync(canonicalWorkspace);
      mkdirSync(projectWorkspace);
      const task = setup(db, dataDir, {
        project: { id: "project-mismatching-workdir", workdir: projectWorkspace },
        profile: {
          driver: "mono",
          configurationOwner: "agent",
          workspaceOwner: "agent",
          mcpOwner: "agent",
          canonicalWorkspace,
        },
      });

      expect(() => spawnTaskRun(runOptions({
        db,
        dataDir,
        task,
        spawn: () => { throw new Error("must not spawn"); },
      }))).toThrow(/does not match the agent-owned ACP workspace/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM task_runs").get().count).toBe(0);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps using the Worklab-selected workspace for a client-owned ACP profile", () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-spawn-"));
    try {
      const globalWorkspace = join(dataDir, "global-workspace");
      const profileCwd = join(dataDir, "profile-cwd");
      mkdirSync(globalWorkspace);
      mkdirSync(profileCwd);
      const task = setup(db, dataDir, { profile: { cwd: profileCwd } });
      let spawned;

      const { runId } = spawnTaskRun(runOptions({
        db,
        dataDir,
        task,
        workspace: globalWorkspace,
        spawn: (options) => {
          spawned = options;
          return { pid: 123, done: new Promise(() => {}) };
        },
      }));

      expect(spawned.env.WORKLAB_WORKSPACE).toBe(globalWorkspace);
      expect(db.prepare("SELECT workdir FROM task_runs WHERE id = ?").get(runId))
        .toEqual({ workdir: globalWorkspace });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

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

  it("reuses only a canonical provider session id bound to the ACP profile", () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-spawn-"));
    try {
      const task = setup(db, dataDir);
      const parentRunId = newRunId();
      const providerSessionId = structuralAcpProviderSessionId("profile-1", "remote-session");
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, provider_kind, started_at, status, process_status, provider_session_id)
        VALUES (?, ?, 'execute', 'execute', 'external', 'acp', ?, 'error', 'failed', ?)
      `).run(parentRunId, task.id, Date.now(), providerSessionId);
      let spawned;

      spawnTaskRun({
        ...runOptions({
          db,
          dataDir,
          task,
          spawn: (options) => {
            spawned = options;
            return { pid: 123, done: new Promise(() => {}) };
          },
        }),
        parentRunId,
        diagnosticsSeed: {
          continuation_of_run_id: parentRunId,
          continuation_reason: "provider_retryable",
        },
      });

      expect(spawned.env.WORKLAB_PROVIDER_SESSION_ID).toBe(providerSessionId);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["raw remote id", "remote-session"],
    ["wrong profile", structuralAcpProviderSessionId("profile-2", "remote-session")],
    ["non-canonical base64url", "acp:v2:profile-1:A"],
  ])("does not reuse a %s during ACP recovery", (_label, providerSessionId) => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-spawn-"));
    try {
      const task = setup(db, dataDir);
      const parentRunId = newRunId();
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, provider_kind, started_at, status, process_status, provider_session_id)
        VALUES (?, ?, 'execute', 'execute', 'external', 'acp', ?, 'error', 'failed', ?)
      `).run(parentRunId, task.id, Date.now(), providerSessionId);
      let spawned;

      spawnTaskRun({
        ...runOptions({
          db,
          dataDir,
          task,
          spawn: (options) => {
            spawned = options;
            return { pid: 123, done: new Promise(() => {}) };
          },
        }),
        parentRunId,
        diagnosticsSeed: {
          continuation_of_run_id: parentRunId,
          continuation_reason: "provider_retryable",
        },
      });

      expect(spawned.env).not.toHaveProperty("WORKLAB_PROVIDER_SESSION_ID");
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
