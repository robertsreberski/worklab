// v33 — team-roster enforcement on the delegation path.
//
// Replaces the retired R9 per-project allowed_agents test. Two-layer coverage:
//   1. Pure-helper unit tests against `enforceTeamRoster` (which delegates
//      to src/core/teams.js#enforceTeamRoster) so the membership semantics
//      are pinned independent of the watcher wiring.
//   2. Integration tests that drive the real watcher via createTaskWatcher
//      and assert the run + task fields the watcher writes when a planner
//      delegates to an off-roster agent.

import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../../helpers/test-db.js";
import { createTaskWatcher } from "../../../coordinator/task-watcher.js";
import { enforceTeamRoster } from "../../../coordinator/watcher/delegation-handler.js";
import { newTaskId, newTeamId } from "../../../core/ids.js";

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

function seedTeam(db, { name = "Bench Team", leadAgent, memberAgents = [] } = {}) {
  const now = Date.now();
  const id = newTeamId();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(0, 4)}`;
  db.prepare(`
    INSERT INTO teams (id, slug, name, description, goal, lead_agent, status, schedule_enabled, created_at, updated_at)
    VALUES (?, ?, ?, '', '', ?, 'active', 0, ?, ?)
  `).run(id, slug, name, leadAgent, now, now);
  for (const agentName of memberAgents) {
    db.prepare(`
      INSERT INTO team_members (team_id, agent_name, role_description, created_at)
      VALUES (?, ?, '', ?)
    `).run(id, agentName, now);
  }
  return { id, slug };
}

function seedProject(db, { teamId = null } = {}) {
  const now = Date.now();
  const projectId = `project-${now}`;
  db.prepare(`
    INSERT INTO projects (id, slug, name, team_id, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(projectId, projectId, "Bench Project", teamId, now, now);
  return { id: projectId };
}

function seedTask(db, { projectId = null, teamId = null, owner = "benchmark-coder" } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks
      (id, root_task_id, project_id, team_id, title, stage, owner_agent, run_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, 't', 'execute', ?, 'manual', ?, ?)`,
  ).run(id, id, projectId, teamId, owner, now, now);
  return id;
}

describe("enforceTeamRoster (pure)", () => {
  it("falls through when no team_id is supplied", () => {
    const db = makeTestDb();
    expect(enforceTeamRoster({
      db,
      teamId: null,
      subtasks: [{ suggested_agent: "anything" }],
      parentOwnerAgent: "anything",
    })).toEqual({ ok: true, warnings: [] });
  });

  it("rejects every candidate when the roster is empty", () => {
    const db = makeTestDb();
    seedAgent(db, "lead");
    const team = seedTeam(db, { leadAgent: "lead", memberAgents: [] });
    // Drop the lead so the roster computes to empty.
    db.prepare("UPDATE teams SET lead_agent = NULL WHERE id = ?").run(team.id);
    const result = enforceTeamRoster({
      db,
      teamId: team.id,
      subtasks: [{ suggested_agent: "lead" }],
      parentOwnerAgent: "lead",
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("delegation_team_roster_empty");
  });

  it("permits agents that are in the roster (lead + members)", () => {
    const db = makeTestDb();
    seedAgent(db, "lead");
    seedAgent(db, "engineer");
    seedAgent(db, "qa");
    const team = seedTeam(db, { leadAgent: "lead", memberAgents: ["engineer", "qa"] });
    const result = enforceTeamRoster({
      db,
      teamId: team.id,
      subtasks: [{ suggested_agent: "engineer" }, { suggested_agent: "qa" }],
      parentOwnerAgent: "lead",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("rejects agents outside the roster with delegation_agent_not_in_team", () => {
    const db = makeTestDb();
    seedAgent(db, "lead");
    seedAgent(db, "engineer");
    seedAgent(db, "rogue");
    const team = seedTeam(db, { leadAgent: "lead", memberAgents: ["engineer"] });
    const result = enforceTeamRoster({
      db,
      teamId: team.id,
      subtasks: [{ suggested_agent: "engineer" }, { suggested_agent: "rogue" }],
      parentOwnerAgent: "lead",
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("delegation_agent_not_in_team");
    expect(result.offenders).toEqual(["rogue"]);
    expect(result.error).toContain('"rogue"');
  });

  it("falls back to the parent owner_agent when a subtask omits suggested_agent", () => {
    const db = makeTestDb();
    seedAgent(db, "lead");
    seedAgent(db, "engineer");
    seedAgent(db, "rogue");
    const team = seedTeam(db, { leadAgent: "lead", memberAgents: ["engineer"] });
    const result = enforceTeamRoster({
      db,
      teamId: team.id,
      subtasks: [{ title: "Child" }, { suggested_agent: "engineer" }],
      parentOwnerAgent: "rogue",
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("delegation_agent_not_in_team");
    expect(result.offenders).toContain("rogue");
  });
});

describe("watcher integration: team roster", () => {
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

  it("fails-fast with delegation_agent_not_in_team when the planner picks an off-roster agent", async () => {
    const db = makeTestDb();
    seedAgent(db, "lead");
    seedAgent(db, "engineer");
    seedAgent(db, "rogue");
    const team = seedTeam(db, { leadAgent: "lead", memberAgents: ["engineer"] });
    const project = seedProject(db, { teamId: team.id });
    const taskId = seedTask(db, { projectId: project.id, owner: "lead" });

    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    const { runId } = await watcher.handleRunRequested(taskId);

    resolveDone(workerExitWithDelegation([
      { title: "Implement feature", suggested_agent: "engineer" },
      { title: "Out-of-roster work", suggested_agent: "rogue" },
    ]));
    await new Promise((r) => setTimeout(r, 30));

    const task = db.prepare("SELECT stage, error_text, last_failure_kind FROM tasks WHERE id = ?").get(taskId);
    const run = db.prepare("SELECT failure_kind FROM task_runs WHERE id = ?").get(runId);
    expect(task.last_failure_kind).toBe("delegation_agent_not_in_team");
    expect(task.error_text).toMatch(/rogue/);
    expect(run.failure_kind).toBe("delegation_agent_not_in_team");
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ?").get(taskId).count).toBe(0);
  });

  it("permits delegation when every agent is in the team roster", async () => {
    const db = makeTestDb();
    seedAgent(db, "lead");
    seedAgent(db, "engineer");
    const team = seedTeam(db, { leadAgent: "lead", memberAgents: ["engineer"] });
    const project = seedProject(db, { teamId: team.id });
    const taskId = seedTask(db, { projectId: project.id, owner: "lead" });

    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolveDone(workerExitWithDelegation([
      { title: "Plan", suggested_agent: "engineer" },
    ]));
    await new Promise((r) => setTimeout(r, 30));

    const child = db.prepare("SELECT id, owner_agent FROM tasks WHERE parent_task_id = ?").get(taskId);
    expect(child).toBeTruthy();
    expect(child.owner_agent).toBe("engineer");
  });

  it("falls through when the parent task has no effective team", async () => {
    const db = makeTestDb();
    seedAgent(db, "lead");
    seedAgent(db, "rogue");
    const taskId = seedTask(db, { projectId: null, owner: "lead" });

    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolveDone(workerExitWithDelegation([
      { title: "Anything goes", suggested_agent: "rogue" },
    ]));
    await new Promise((r) => setTimeout(r, 30));

    const child = db.prepare("SELECT id FROM tasks WHERE parent_task_id = ?").get(taskId);
    expect(child).toBeTruthy();
    const task = db.prepare("SELECT last_failure_kind FROM tasks WHERE id = ?").get(taskId);
    expect(task.last_failure_kind).toBeNull();
  });
});
