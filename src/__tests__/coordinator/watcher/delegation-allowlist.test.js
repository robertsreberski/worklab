// R9 — per-project agent allowlist enforcement on the delegation path.
//
// Two-layer coverage:
//   1. Pure-helper unit tests against `enforceProjectAgentAllowlist` so the
//      glob-match contract + override semantics are pinned independent of
//      the watcher wiring.
//   2. Integration tests that drive the real watcher via createTaskWatcher
//      and assert the run + task fields the watcher writes when a planner
//      delegates to an out-of-fleet agent.

import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../../helpers/test-db.js";
import { createTaskWatcher } from "../../../coordinator/task-watcher.js";
import { enforceProjectAgentAllowlist } from "../../../coordinator/watcher/delegation-handler.js";
import { newTaskId } from "../../../core/ids.js";

function stubBroker() {
  return {
    subscribe: () => {},
    unsubscribe: () => {},
    size: () => 0,
    broadcast: () => {},
  };
}

function seedAgent(db, name) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(name, name, "claude", "claude:claude-sonnet-4-6", now, now);
}

function seedProject(db, patch = {}) {
  const now = Date.now();
  const project = {
    id: patch.id || "project-r9",
    slug: patch.slug || "project-r9",
    name: patch.name || "Project R9",
    allowed_agents_json: JSON.stringify(patch.allowed_agents || []),
    delegation_allow_unlisted: patch.delegation_allow_unlisted ? 1 : 0,
  };
  db.prepare(`
    INSERT INTO projects
      (id, slug, name, description, context_markdown, workdir, tags_json,
       allowed_agents_json, delegation_allow_unlisted, archived, created_at, updated_at)
    VALUES (?, ?, ?, '', '', NULL, '[]', ?, ?, 0, ?, ?)
  `).run(
    project.id, project.slug, project.name,
    project.allowed_agents_json, project.delegation_allow_unlisted,
    now, now,
  );
  return project;
}

function seedTask(db, { projectId = null, owner = "benchmark-coder" } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks
      (id, root_task_id, project_id, title, stage, owner_agent, run_policy, created_at, updated_at)
     VALUES (?, ?, ?, 't', 'execute', ?, 'manual', ?, ?)`,
  ).run(id, id, projectId, owner, now, now);
  return id;
}

describe("enforceProjectAgentAllowlist (pure)", () => {
  it("falls through when no project allowlist is supplied", () => {
    expect(enforceProjectAgentAllowlist({
      subtasks: [{ suggested_agent: "anything" }],
      parentOwnerAgent: "anything",
      projectAllowlist: null,
    })).toEqual({ ok: true, warnings: [] });
  });

  it("treats an empty allowlist as 'any agent'", () => {
    expect(enforceProjectAgentAllowlist({
      subtasks: [{ suggested_agent: "github-dev" }],
      parentOwnerAgent: "github-dev",
      projectAllowlist: { allowed_agents: [], delegation_allow_unlisted: false },
    })).toEqual({ ok: true, warnings: [] });
  });

  it("permits agents that match a glob pattern", () => {
    const result = enforceProjectAgentAllowlist({
      subtasks: [
        { suggested_agent: "benchmark-planner" },
        { suggested_agent: "benchmark-qa" },
      ],
      parentOwnerAgent: "benchmark-coder",
      projectAllowlist: { allowed_agents: ["benchmark-*"], delegation_allow_unlisted: false },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("falls back to the parent owner_agent when a subtask omits suggested_agent", () => {
    const result = enforceProjectAgentAllowlist({
      subtasks: [{ title: "Child" }, { suggested_agent: "benchmark-qa" }],
      parentOwnerAgent: "github-dev",
      projectAllowlist: { allowed_agents: ["benchmark-*"], delegation_allow_unlisted: false },
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("delegation_agent_not_allowed");
    expect(result.offenders).toContain("github-dev");
  });

  it("fails-fast when an agent is outside the allowlist and override is off", () => {
    const result = enforceProjectAgentAllowlist({
      subtasks: [{ suggested_agent: "github-dev" }, { suggested_agent: "benchmark-qa" }],
      parentOwnerAgent: "benchmark-coder",
      projectAllowlist: { allowed_agents: ["benchmark-*"], delegation_allow_unlisted: false },
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("delegation_agent_not_allowed");
    expect(result.offenders).toEqual(["github-dev"]);
    expect(result.error).toContain('"github-dev"');
    expect(result.error).toContain('"benchmark-*"');
  });

  it("downgrades to a warning when override is on", () => {
    const result = enforceProjectAgentAllowlist({
      subtasks: [{ suggested_agent: "github-dev" }],
      parentOwnerAgent: "benchmark-coder",
      projectAllowlist: { allowed_agents: ["benchmark-*"], delegation_allow_unlisted: true },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      kind: "delegation_unlisted_agent",
      offenders: ["github-dev"],
    });
  });

  it("dedupes offender names across multiple subtasks", () => {
    const result = enforceProjectAgentAllowlist({
      subtasks: [
        { suggested_agent: "github-dev" },
        { suggested_agent: "github-dev" },
        { suggested_agent: "github-dev" },
      ],
      parentOwnerAgent: "benchmark-coder",
      projectAllowlist: { allowed_agents: ["benchmark-*"], delegation_allow_unlisted: false },
    });
    expect(result.ok).toBe(false);
    expect(result.offenders).toEqual(["github-dev"]);
  });

  it("matches literal agent names when the pattern has no glob", () => {
    const result = enforceProjectAgentAllowlist({
      subtasks: [{ suggested_agent: "exact-match" }],
      parentOwnerAgent: null,
      projectAllowlist: { allowed_agents: ["exact-match"], delegation_allow_unlisted: false },
    });
    expect(result.ok).toBe(true);
  });
});

describe("watcher integration: project allowlist", () => {
  const delegationResult = (subtasks) => ({
    schema: "worklab.v2",
    stage: "execute",
    decision: "delegate",
    summary: "Delegated",
    details: "",
    artifacts: {},
    blocking_issues: [],
    pending_actions: [],
    subtasks,
  });

  function workerExitWithDelegation(subtasks) {
    return {
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Delegated.",
      worklabResult: delegationResult(subtasks),
    };
  }

  it("fails-fast with delegation_agent_not_allowed when an agent is outside the allowlist", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-qa");
    seedAgent(db, "github-dev");
    const project = seedProject(db, { allowed_agents: ["benchmark-*"], delegation_allow_unlisted: false });
    const taskId = seedTask(db, { projectId: project.id, owner: "benchmark-coder" });

    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    const { runId } = await watcher.handleRunRequested(taskId);

    resolveDone(workerExitWithDelegation([
      { title: "Implement feature", suggested_agent: "github-dev" },
      { title: "QA the feature", suggested_agent: "benchmark-qa" },
    ]));
    await new Promise((r) => setTimeout(r, 30));

    const task = db.prepare("SELECT stage, error_text, last_failure_kind FROM tasks WHERE id = ?").get(taskId);
    const run = db.prepare("SELECT failure_kind FROM task_runs WHERE id = ?").get(runId);
    expect(task.last_failure_kind).toBe("delegation_agent_not_allowed");
    expect(task.error_text).toMatch(/delegation rejected/);
    expect(task.error_text).toMatch(/github-dev/);
    expect(run.failure_kind).toBe("delegation_agent_not_allowed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ?").get(taskId).count).toBe(0);
  });

  it("permits delegation outside the allowlist when delegation_allow_unlisted is set", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "github-dev");
    const project = seedProject(db, { allowed_agents: ["benchmark-*"], delegation_allow_unlisted: true });
    const taskId = seedTask(db, { projectId: project.id, owner: "benchmark-coder" });

    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    const { runId } = await watcher.handleRunRequested(taskId);

    resolveDone(workerExitWithDelegation([
      { title: "Out-of-fleet work", suggested_agent: "github-dev" },
    ]));
    await new Promise((r) => setTimeout(r, 30));

    const child = db.prepare("SELECT id, project_id, owner_agent FROM tasks WHERE parent_task_id = ?").get(taskId);
    expect(child).toBeTruthy();
    expect(child.owner_agent).toBe("github-dev");
    expect(child.project_id).toBe(project.id);

    const run = db.prepare("SELECT warnings_json FROM task_runs WHERE id = ?").get(runId);
    const warnings = JSON.parse(run.warnings_json || "[]");
    expect(warnings.some((w) => w?.kind === "delegation_unlisted_agent")).toBe(true);

    const comment = db.prepare(
      "SELECT body FROM task_comments WHERE task_id = ? AND body LIKE '%delegation_allow_unlisted%' ORDER BY created_at DESC",
    ).get(taskId);
    expect(comment).toBeTruthy();
  });

  it("falls through when the parent task is not bound to a project", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "github-dev");
    const taskId = seedTask(db, { projectId: null, owner: "benchmark-coder" });

    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolveDone(workerExitWithDelegation([
      { title: "Anything goes", suggested_agent: "github-dev" },
    ]));
    await new Promise((r) => setTimeout(r, 30));

    const child = db.prepare("SELECT id FROM tasks WHERE parent_task_id = ?").get(taskId);
    expect(child).toBeTruthy();
    const task = db.prepare("SELECT last_failure_kind FROM tasks WHERE id = ?").get(taskId);
    expect(task.last_failure_kind).toBeNull();
  });

  it("permits delegation when every agent matches the allowlist", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-qa");
    const project = seedProject(db, { allowed_agents: ["benchmark-*"], delegation_allow_unlisted: false });
    const taskId = seedTask(db, { projectId: project.id, owner: "benchmark-coder" });

    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    const { runId } = await watcher.handleRunRequested(taskId);

    resolveDone(workerExitWithDelegation([
      { title: "Plan", suggested_agent: "benchmark-qa" },
    ]));
    await new Promise((r) => setTimeout(r, 30));

    const child = db.prepare("SELECT id FROM tasks WHERE parent_task_id = ?").get(taskId);
    expect(child).toBeTruthy();
    const run = db.prepare("SELECT warnings_json FROM task_runs WHERE id = ?").get(runId);
    const warnings = JSON.parse(run.warnings_json || "[]");
    expect(warnings.some((w) => w?.kind === "delegation_unlisted_agent")).toBe(false);
  });
});
