import { describe, it, expect, vi } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

function seedLead(db, name = "lead") {
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)
  `).run(name, name, now, now);
}

describe("/api/goals", () => {
  it("lists and gets team-project goals by stable goal id", async () => {
    const { agent, db } = makeTestServer();
    seedLead(db);
    const { body: { team } } = await agent.post("/api/teams").send({
      name: "Goal Team",
      goal: "Make goals native",
      lead_agent: "lead",
    }).expect(201);
    const { body: { project } } = await agent.post("/api/projects").send({
      name: "Goal Project",
      team_id: team.slug,
    }).expect(201);

    const list = await agent.get("/api/goals").expect(200);

    expect(list.body.goals).toHaveLength(1);
    expect(list.body.goals[0]).toMatchObject({
      id: expect.any(String),
      goal_id: expect.any(String),
      root_task_id: expect.any(String),
      team_id: team.id,
      team_slug: team.slug,
      project_id: project.id,
      project: { id: project.id, slug: project.slug },
      contract: { objective: "Make goals native" },
    });
    expect(list.body.goals[0].id).toBe(list.body.goals[0].root_task_id);
    expect(list.body.goals[0].goal_id).toBe(list.body.goals[0].root_task_id);

    const detail = await agent.get(`/api/goals/${list.body.goals[0].goal_id}`).expect(200);
    expect(detail.body.goal).toMatchObject({
      goal_id: list.body.goals[0].goal_id,
      team_id: team.id,
      project_id: project.id,
    });
  });

  it("creates a goal by assigning an unassigned project to a team", async () => {
    const { agent, db } = makeTestServer();
    seedLead(db);
    const { body: { team } } = await agent.post("/api/teams").send({
      name: "Create Goal Team",
      goal: "Default charter",
      lead_agent: "lead",
    }).expect(201);
    const { body: { project } } = await agent.post("/api/projects").send({ name: "Unassigned Project" }).expect(201);

    const created = await agent.post("/api/goals").send({
      team_id: team.slug,
      project_id: project.slug,
      objective: "Ship the native goals surface",
      stopping_condition: "Goals are editable from their own route",
      validation_loop: "npm run build:ui",
      constraints: ["No standalone goal table"],
    }).expect(201);

    expect(created.body.goal).toMatchObject({
      id: expect.any(String),
      team_id: team.id,
      project_id: project.id,
      contract: {
        objective: "Ship the native goals surface",
        stopping_condition: "Goals are editable from their own route",
        validation_loop: "npm run build:ui",
        constraints: ["No standalone goal table"],
      },
    });

    const projectDetail = await agent.get(`/api/projects/${project.id}`).expect(200);
    expect(projectDetail.body.project.team_id).toBe(team.id);

    const detail = await agent.get(`/api/goals/${created.body.goal.id}`).expect(200);
    expect(detail.body.goal.contract.objective).toBe("Ship the native goals surface");
  });

  it("does not silently reassign a project that already belongs to another team", async () => {
    const { agent, db } = makeTestServer();
    seedLead(db, "lead-a");
    seedLead(db, "lead-b");
    const { body: { team: firstTeam } } = await agent.post("/api/teams").send({
      name: "First Team",
      lead_agent: "lead-a",
    }).expect(201);
    const { body: { team: secondTeam } } = await agent.post("/api/teams").send({
      name: "Second Team",
      lead_agent: "lead-b",
    }).expect(201);
    const { body: { project } } = await agent.post("/api/projects").send({
      name: "Owned Project",
      team_id: firstTeam.id,
    }).expect(201);

    const res = await agent.post("/api/goals").send({
      team_id: secondTeam.id,
      project_id: project.id,
      objective: "Take over",
    }).expect(409);

    expect(res.body.error.code).toBe("conflict");
    const projectDetail = await agent.get(`/api/projects/${project.id}`).expect(200);
    expect(projectDetail.body.project.team_id).toBe(firstTeam.id);
  });

  it("patches and controls a goal by goal id", async () => {
    const { agent, db } = makeTestServer();
    seedLead(db);
    const { body: { team } } = await agent.post("/api/teams").send({
      name: "Patch Goal Team",
      goal: "Start here",
      lead_agent: "lead",
    }).expect(201);
    await agent.post("/api/projects").send({ name: "Patch Project", team_id: team.id }).expect(201);
    const { body: { goals } } = await agent.get("/api/goals").expect(200);
    const goalId = goals[0].goal_id;

    const patched = await agent.patch(`/api/goals/${goalId}`).send({
      objective: "Finish the native route",
      stopping_condition: "Route works",
      validation_loop: "npx vitest run src/__tests__/api/routes-goals.test.js",
      constraints: ["Keep Teams optional"],
    }).expect(200);

    expect(patched.body.goal.contract).toMatchObject({
      objective: "Finish the native route",
      stopping_condition: "Route works",
      validation_loop: "npx vitest run src/__tests__/api/routes-goals.test.js",
      constraints: ["Keep Teams optional"],
    });

    const paused = await agent.patch(`/api/goals/${goalId}`).send({ action: "pause" }).expect(200);
    expect(paused.body.goal.contract.paused_at).toEqual(expect.any(Number));
    const resumed = await agent.patch(`/api/goals/${goalId}`).send({ action: "resume" }).expect(200);
    expect(resumed.body.goal.contract.paused_at).toBe(null);
  });

  it("returns goal readiness and normalized reference links", async () => {
    const { agent, db } = makeTestServer();
    seedLead(db);
    const { body: { team } } = await agent.post("/api/teams").send({
      name: "Reference Team",
      goal: "Keep references visible",
      lead_agent: "lead",
    }).expect(201);
    const { body: { project } } = await agent.post("/api/projects").send({
      name: "Reference Project",
      team_id: team.id,
    }).expect(201);
    const { body: { goals } } = await agent.get("/api/goals").expect(200);
    const goalId = goals[0].goal_id;

    const notReady = await agent.patch(`/api/goals/${goalId}`).send({
      objective: "Ship better goal references",
      stopping_condition: "",
      validation_loop: "",
      links: [
        { label: "Spec", url: "https://example.com/spec" },
        { label: "", url: "javascript:alert(1)" },
        "https://example.com/plain",
      ],
    }).expect(200);

    expect(notReady.body.goal.readiness).toEqual({
      ready: false,
      missing: ["stopping_condition", "validation_loop"],
    });
    expect(notReady.body.goal.contract.links).toEqual([
      { label: "Spec", url: "https://example.com/spec" },
      { label: "https://example.com/plain", url: "https://example.com/plain" },
    ]);

    const ready = await agent.patch(`/api/goals/${goalId}`).send({
      stopping_condition: "The goal page shows structured links.",
      validation_loop: "npx vitest run src/__tests__/api/routes-goals.test.js",
    }).expect(200);

    expect(ready.body.goal.readiness).toEqual({ ready: true, missing: [] });
    expect(ready.body.goal.project_id).toBe(project.id);
  });

  it("runs a lead cycle from the goal resource", async () => {
    const spawnLeadCycle = vi.fn(({ teamId, projectId }) => ({ ok: true, runId: `run-${teamId}-${projectId}`, taskId: `root-${teamId}-${projectId}` }));
    const { agent, db } = makeTestServer({ watcher: {
      handleRunRequested: async () => ({ runId: "normal-run" }),
      cancel: () => true,
      shutdown: async () => {},
      isActive: () => false,
      spawnLeadCycle,
    } });
    seedLead(db);
    const { body: { team } } = await agent.post("/api/teams").send({
      name: "Run Goal Team",
      lead_agent: "lead",
    }).expect(201);
    const { body: { project } } = await agent.post("/api/projects").send({
      name: "Run Project",
      team_id: team.id,
    }).expect(201);
    const { body: { goals } } = await agent.get("/api/goals").expect(200);

    const res = await agent.post(`/api/goals/${goals[0].goal_id}/run`).send({ reason: "manual" }).expect(202);

    expect(res.body).toMatchObject({
      ok: true,
      runId: `run-${team.id}-${project.id}`,
    });
    expect(spawnLeadCycle).toHaveBeenCalledWith({ teamId: team.id, projectId: project.id, reason: "manual" });
  });
});
