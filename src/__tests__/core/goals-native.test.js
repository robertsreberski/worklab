import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { ensureTeamRootTask } from "../../core/teams.js";
import {
  getTeamProjectGoal,
  listLeadCyclesForGoal,
  recordLeadCycleCompleted,
  recordLeadCycleStarted,
  updateTeamProjectGoal,
} from "../../core/goals.js";

function seedAgent(db, name) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', ?, ?)",
  ).run(name, name, now, now);
}

function seedTeamProject(db) {
  const now = Date.now();
  seedAgent(db, "lead");
  seedAgent(db, "engineer");
  db.prepare(`
    INSERT INTO teams (id, slug, name, description, goal, lead_agent, status, schedule_enabled, created_at, updated_at)
    VALUES ('team-native', 'team-native', 'Native Team', '', 'Make goals native', 'lead', 'active', 0, ?, ?)
  `).run(now, now);
  db.prepare("INSERT INTO team_members (team_id, agent_name, role_description, created_at) VALUES ('team-native', 'engineer', '', ?)")
    .run(now);
  db.prepare(`
    INSERT INTO projects (id, slug, name, team_id, archived, created_at, updated_at)
    VALUES ('project-native', 'project-native', 'Native Project', 'team-native', 0, ?, ?)
  `).run(now, now);
  return { teamId: "team-native", projectId: "project-native" };
}

describe("native goals and lead cycles", () => {
  it("materializes team-project goals in a native goals table while preserving the root task anchor", () => {
    const db = makeTestDb();
    const { teamId, projectId } = seedTeamProject(db);
    const root = ensureTeamRootTask(db, { teamId, projectId, now: 1000 });

    const goal = getTeamProjectGoal(db, { teamId, projectId, now: 1000 });

    expect(goal).toMatchObject({
      id: root.id,
      goal_id: root.id,
      root_task_id: root.id,
      team_id: teamId,
      project_id: projectId,
      goal_status: "in_progress",
      contract: { objective: "Make goals native" },
    });
    const nativeRow = db.prepare("SELECT * FROM goals WHERE id = ?").get(goal.goal_id);
    expect(nativeRow).toMatchObject({
      id: root.id,
      root_task_id: root.id,
      team_id: teamId,
      project_id: projectId,
      status: "in_progress",
    });
    expect(JSON.parse(nativeRow.contract_json).objective).toBe("Make goals native");

    const patched = updateTeamProjectGoal(db, {
      teamId,
      projectId,
      patch: {
        objective: "Run the polished native cockpit",
        stopping_condition: "The goal timeline is durable",
        validation_loop: "npx vitest run src/__tests__/core/goals-native.test.js",
      },
      now: 2000,
    });

    expect(patched.ok).toBe(true);
    expect(db.prepare("SELECT contract_json FROM goals WHERE id = ?").get(goal.goal_id).contract_json)
      .toContain("Run the polished native cockpit");
    expect(db.prepare("SELECT goal_contract_json FROM tasks WHERE id = ?").get(root.id).goal_contract_json)
      .toContain("Run the polished native cockpit");
  });

  it("records lead-cycle decisions as native timeline entries with operational review hints", () => {
    const db = makeTestDb();
    const { teamId, projectId } = seedTeamProject(db);
    const goal = getTeamProjectGoal(db, { teamId, projectId, now: 1000 });
    db.prepare(`
      INSERT INTO task_runs
        (id, task_id, project_id, team_id, kind, mode, stage, agent_name, started_at, status, process_status)
      VALUES ('run-native-1', ?, ?, ?, 'lead_cycle', 'execute', 'execute', 'lead', 3000, 'running', 'running')
    `).run(goal.root_task_id, projectId, teamId);

    recordLeadCycleStarted(db, {
      goalId: goal.goal_id,
      runId: "run-native-1",
      taskId: goal.root_task_id,
      teamId,
      projectId,
      reason: "manual",
      startedAt: 3000,
    });
    recordLeadCycleCompleted(db, {
      runId: "run-native-1",
      result: {
        schema: "worklab.lead_cycle.v1",
        goal_status: "blocked",
        goal_status_reason: "Needs implementation evidence.",
        summary: "Reviewed the current goal state.",
        checkpoint_note: "Waiting on a native timeline.",
        validation_summary: "Tests define the expected surface.",
        task_creations: [{ title: "Add native rows" }],
        task_assignments: [{ target_task_id: "task-1", owner_agent: "engineer", rationale: "Best owner." }],
        advisory_notes: [{ target_task_id: goal.root_task_id, kind: "suggestion", content: "Keep the timeline visible." }],
        next_review_hint: { after_minutes: 30, after_event: "task_completed" },
      },
      processStatus: "succeeded",
      status: "complete",
      costUsd: 0.05,
      tasksCreated: 1,
      tasksAssigned: 1,
      notesPosted: 1,
      endedAt: 4000,
    });

    const cycles = listLeadCyclesForGoal(db, goal.goal_id);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({
      id: "run-native-1",
      goal_id: goal.goal_id,
      run_id: "run-native-1",
      reason: "manual",
      process_status: "succeeded",
      goal_status: "blocked",
      summary: "Reviewed the current goal state.",
      checkpoint_note: "Waiting on a native timeline.",
      next_review_due_at: 4000 + 30 * 60 * 1000,
      next_review_event: "task_completed",
      tasks_created: 1,
      tasks_assigned: 1,
      notes_posted: 1,
      cost_usd: 0.05,
    });
    expect(cycles[0].task_assignments[0].owner_agent).toBe("engineer");
    expect(cycles[0].advisory_notes[0].content).toBe("Keep the timeline visible.");
  });
});
