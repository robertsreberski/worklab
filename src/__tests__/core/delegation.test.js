import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { buildDelegationContext, delegationDepth, loadChildTaskSummaries } from "../../core/delegation.js";

function seedAgent(db, name, patch = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents
      (name, display_name, description, sdk, model, effort, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    patch.display_name || name,
    patch.description || "",
    patch.sdk || "codex",
    patch.model || "pi:openai-codex:gpt-5.5",
    patch.effort || "xhigh",
    patch.enabled === false ? 0 : 1,
    now,
    now,
  );
}

function seedTask(db, id, patch = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks
      (id, root_task_id, parent_task_id, project_id, team_id, title, instructions, stage, owner_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    patch.root_task_id || id,
    patch.parent_task_id || null,
    patch.project_id || null,
    patch.team_id || null,
    patch.title || id,
    patch.instructions || "",
    patch.stage || "execute",
    patch.owner_agent || null,
    now,
    now,
  );
}

function seedTeamProject(db, { teamId = "team-1", projectId = "project-1", lead = "lead", members = [] } = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO teams (id, slug, name, lead_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(teamId, teamId, teamId, lead, now, now);
  for (const member of members) {
    db.prepare(`
      INSERT INTO team_members (team_id, agent_name, role_description, created_at)
      VALUES (?, ?, '', ?)
    `).run(teamId, member, now);
  }
  db.prepare(`
    INSERT INTO projects (id, slug, name, team_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, projectId, projectId, teamId, now, now);
  return { teamId, projectId };
}

function linkChild(db, parentId, childId, required = 1) {
  db.prepare(`
    INSERT INTO task_edges (parent_task_id, child_task_id, edge_type, required, created_at)
    VALUES (?, ?, 'subtask', ?, ?)
  `).run(parentId, childId, required, Date.now());
}

describe("delegation context", () => {
  it("computes depth through parent task links", () => {
    const db = makeTestDb();
    seedTask(db, "root");
    seedTask(db, "child", { parent_task_id: "root", root_task_id: "root" });
    seedTask(db, "grandchild", { parent_task_id: "child", root_task_id: "root" });

    expect(delegationDepth(db, db.prepare("SELECT * FROM tasks WHERE id = ?").get("root"))).toBe(0);
    expect(delegationDepth(db, db.prepare("SELECT * FROM tasks WHERE id = ?").get("grandchild"))).toBe(2);
  });

  it("builds policy, agent roster, and child summaries", () => {
    const db = makeTestDb();
    seedAgent(db, "owner", { display_name: "Owner Agent", description: "Owns broad work." });
    seedAgent(db, "disabled", { enabled: false });
    seedTask(db, "parent", { owner_agent: "owner" });
    seedTask(db, "child", { parent_task_id: "parent", root_task_id: "parent", owner_agent: "owner", stage: "done" });
    linkChild(db, "parent", "child");
    db.prepare(`
      INSERT INTO task_runs
        (id, task_id, mode, stage, agent_name, status, process_status, decision, summary,
         result_json, artifact_summary_json, started_at, ended_at)
      VALUES (?, ?, 'execute', 'execute', ?, 'complete', 'succeeded', 'advance', ?, ?, ?, ?, ?)
    `).run(
      "run-child",
      "child",
      "owner",
      "Child finished.",
      JSON.stringify({ schema: "worklab.v2", decision: "advance", summary: "Structured child summary." }),
      JSON.stringify({ files_changed: 2 }),
      1000,
      2000,
    );

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get("parent");
    const context = buildDelegationContext({
      db,
      task,
      settings: {
        delegation_enabled: true,
        delegation_max_depth: 1,
        delegation_max_children_per_round: 5,
        delegation_max_parallel_children: 3,
        delegation_auto_run_children: true,
      },
    });

    expect(context.canDelegate).toBe(true);
    expect(context.availableAgents.map((agent) => agent.name)).toEqual(["owner"]);
    expect(context.childTasks[0]).toMatchObject({
      id: "child",
      required: true,
      latest_run: {
        id: "run-child",
        decision: "advance",
        summary: "Child finished.",
        artifact_summary: { files_changed: 2 },
      },
    });
    expect(loadChildTaskSummaries(db, "parent")).toHaveLength(1);
  });

  it("limits available delegation agents to the effective team roster", () => {
    const db = makeTestDb();
    seedAgent(db, "lead");
    seedAgent(db, "member");
    seedAgent(db, "executor");
    const { projectId } = seedTeamProject(db, { lead: "lead", members: ["member"] });
    seedTask(db, "parent", { owner_agent: "lead", project_id: projectId });

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get("parent");
    const context = buildDelegationContext({
      db,
      task,
      settings: {
        delegation_enabled: true,
        delegation_max_depth: 1,
        delegation_max_children_per_round: 5,
        delegation_max_parallel_children: 3,
        delegation_auto_run_children: true,
      },
    });

    expect(context.availableAgents.map((agent) => agent.name).sort()).toEqual(["lead", "member"]);
    expect(context.availableAgents.map((agent) => agent.name)).not.toContain("executor");
  });

  it("disables delegation when the task reaches max depth", () => {
    const db = makeTestDb();
    seedTask(db, "root");
    seedTask(db, "child", { parent_task_id: "root", root_task_id: "root" });
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get("child");

    const context = buildDelegationContext({
      db,
      task,
      settings: { delegation_enabled: true, delegation_max_depth: 1 },
    });

    expect(context.canDelegate).toBe(false);
    expect(context.disabledReason).toMatch(/depth limit/);
  });
});
