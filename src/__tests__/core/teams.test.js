import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import {
  effectiveTeamForTask,
  ensureTeamRootTask,
  enforceTeamRoster,
  enqueueLeadCycle,
  loadTeamRoster,
} from "../../core/teams.js";
import { newTeamId } from "../../core/ids.js";

function seedAgent(db, name) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', ?, ?)",
  ).run(name, name, now, now);
}

function seedTeam(db, { lead = "lead", members = ["engineer"] } = {}) {
  const now = Date.now();
  const id = newTeamId();
  db.prepare(`
    INSERT INTO teams (id, slug, name, description, goal, lead_agent, status, schedule_enabled, created_at, updated_at)
    VALUES (?, ?, 'Bench', '', 'Build it', ?, 'active', 0, ?, ?)
  `).run(id, `team-${id}`, lead, now, now);
  for (const member of members) {
    db.prepare("INSERT INTO team_members (team_id, agent_name, role_description, created_at) VALUES (?, ?, '', ?)")
      .run(id, member, now);
  }
  return id;
}

function seedProject(db, { teamId = null } = {}) {
  const now = Date.now();
  const id = `proj-${now}`;
  db.prepare(
    "INSERT INTO projects (id, slug, name, team_id, archived, created_at, updated_at) VALUES (?, ?, 'Project', ?, 0, ?, ?)",
  ).run(id, id, teamId, now, now);
  return id;
}

describe("core/teams.js", () => {
  it("loadTeamRoster returns the lead and member set", () => {
    const db = makeTestDb();
    seedAgent(db, "lead"); seedAgent(db, "engineer"); seedAgent(db, "qa");
    const teamId = seedTeam(db, { lead: "lead", members: ["engineer", "qa"] });
    const roster = loadTeamRoster(db, teamId);
    expect(roster.lead_agent).toBe("lead");
    expect(roster.member_agents.sort()).toEqual(["engineer", "lead", "qa"].sort());
  });

  it("effectiveTeamForTask falls through task -> project", () => {
    const db = makeTestDb();
    seedAgent(db, "lead"); seedAgent(db, "engineer");
    const teamId = seedTeam(db);
    const projectId = seedProject(db, { teamId });
    const taskRow = { id: "t1", project_id: projectId, team_id: null };
    expect(effectiveTeamForTask(db, taskRow)).toBe(teamId);
  });

  it("effectiveTeamForTask honors an explicit task.team_id override", () => {
    const db = makeTestDb();
    seedAgent(db, "lead"); seedAgent(db, "engineer");
    const teamA = seedTeam(db);
    const teamB = seedTeam(db, { lead: "lead", members: [] });
    const projectId = seedProject(db, { teamId: teamA });
    expect(effectiveTeamForTask(db, { id: "t", project_id: projectId, team_id: teamB })).toBe(teamB);
  });

  it("enforceTeamRoster permits roster members and rejects others", () => {
    const db = makeTestDb();
    seedAgent(db, "lead"); seedAgent(db, "engineer"); seedAgent(db, "rogue");
    const teamId = seedTeam(db, { lead: "lead", members: ["engineer"] });
    const ok = enforceTeamRoster(db, { teamId, candidates: ["lead", "engineer"] });
    expect(ok.ok).toBe(true);
    const fail = enforceTeamRoster(db, { teamId, candidates: ["engineer", "rogue"] });
    expect(fail.ok).toBe(false);
    expect(fail.failureKind).toBe("delegation_agent_not_in_team");
    expect(fail.offenders).toEqual(["rogue"]);
  });

  it("ensureTeamRootTask is idempotent and creates a is_team_root task with goal_status=in_progress", () => {
    const db = makeTestDb();
    seedAgent(db, "lead"); seedAgent(db, "engineer");
    const teamId = seedTeam(db);
    const projectId = seedProject(db, { teamId });
    const first = ensureTeamRootTask(db, { teamId, projectId });
    const second = ensureTeamRootTask(db, { teamId, projectId });
    expect(first.id).toBe(second.id);
    expect(first.is_team_root).toBe(1);
    expect(first.goal_status).toBe("in_progress");
    expect(first.team_id).toBe(teamId);
    expect(first.project_id).toBe(projectId);
    const all = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE team_id = ?").get(teamId).c;
    expect(all).toBe(1);
  });

  it("enqueueLeadCycle returns a descriptor with the synthetic root task id", () => {
    const db = makeTestDb();
    seedAgent(db, "lead"); seedAgent(db, "engineer");
    const teamId = seedTeam(db);
    const projectId = seedProject(db, { teamId });
    const out = enqueueLeadCycle(db, { teamId, projectId, reason: "manual" });
    expect(out.ok).toBe(true);
    expect(out.leadAgent).toBe("lead");
    expect(out.rootTaskId).toBeTruthy();
  });

  it("enqueueLeadCycle fails when the team has no lead", () => {
    const db = makeTestDb();
    seedAgent(db, "lead"); seedAgent(db, "engineer");
    const teamId = seedTeam(db);
    db.prepare("UPDATE teams SET lead_agent = NULL WHERE id = ?").run(teamId);
    const projectId = seedProject(db, { teamId });
    const out = enqueueLeadCycle(db, { teamId, projectId });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/lead_agent/);
  });
});
