import { describe, it, expect, afterAll, vi } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";
import { createWatcherProxy } from "../../coordinator.js";

describe("/api/teams", () => {
  it("GET /api/teams returns []", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/teams").expect(200);
    expect(res.body.teams).toEqual([]);
  });

  it("POST /api/teams creates a team and returns it", async () => {
    const { agent, db } = makeTestServer();
    // Lead agent must be enabled.
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at) VALUES ('lead', 'Lead', 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)").run(Date.now(), Date.now());
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at) VALUES ('eng', 'Eng', 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)").run(Date.now(), Date.now());
    const res = await agent.post("/api/teams").send({
      name: "Bench",
      goal: "Beat last week's score",
      lead_agent: "lead",
      members: [{ agent_name: "eng", role_description: "Engineering" }],
      schedule_enabled: true,
      schedule_interval_minutes: 60,
      daily_budget_usd: 5,
    }).expect(201);

    expect(res.body.team.name).toBe("Bench");
    expect(res.body.team.lead_agent).toBe("lead");
    expect(res.body.team.schedule_enabled).toBe(true);
    expect(res.body.team.schedule_interval_minutes).toBe(60);
    expect(res.body.team.daily_budget_usd).toBe(5);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0].agent_name).toBe("eng");
  });

  it("rejects POST when lead_agent does not exist", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/teams").send({
      name: "Ghost",
      lead_agent: "nobody",
    }).expect(400);
    expect(res.body.error.code).toBe("validation");
  });

  it("PATCH replaces the roster when members[] is supplied", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at) VALUES ('lead', 'Lead', 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at) VALUES ('a1', 'A1', 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at) VALUES ('a2', 'A2', 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)").run(now, now);

    const created = await agent.post("/api/teams").send({
      name: "Roster",
      lead_agent: "lead",
      members: [{ agent_name: "a1" }],
    }).expect(201);

    const patched = await agent.patch(`/api/teams/${created.body.team.id}`).send({
      members: [{ agent_name: "a2", role_description: "Replacement" }],
    }).expect(200);

    expect(patched.body.members.map((m) => m.agent_name)).toEqual(["a2"]);
  });

  it("DELETE archives a team", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at) VALUES ('lead', 'Lead', 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)").run(now, now);
    const created = await agent.post("/api/teams").send({ name: "Archivable", lead_agent: "lead" }).expect(201);
    await agent.delete(`/api/teams/${created.body.team.id}`).expect(204);
    const list = await agent.get("/api/teams").expect(200);
    expect(list.body.teams.find((t) => t.id === created.body.team.id)).toBeUndefined();
    const includeArchived = await agent.get("/api/teams?include_archived=true").expect(200);
    expect(includeArchived.body.teams.find((t) => t.id === created.body.team.id)?.status).toBe("archived");
  });

  it("POST /api/teams/:id/run-lead requires at least one assigned project", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at) VALUES ('lead', 'Lead', 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)").run(now, now);
    const created = await agent.post("/api/teams").send({ name: "Idle", lead_agent: "lead" }).expect(201);
    const res = await agent.post(`/api/teams/${created.body.team.id}/run-lead`).send({}).expect(400);
    expect(res.body.error.code).toBe("no_projects");
  });

  it("POST /api/teams/:id/run-lead returns not_configured when the watcher cannot spawn lead cycles", async () => {
    const { agent, db } = makeTestServer({ watcher: { maybeAutoStart: () => {} } });
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at) VALUES ('lead', 'Lead', 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)").run(now, now);
    const { body: { team } } = await agent.post("/api/teams").send({ name: "Needs Watcher", lead_agent: "lead" }).expect(201);
    await agent.post("/api/projects").send({ name: "Lead Project", team_id: team.id }).expect(201);

    const res = await agent.post(`/api/teams/${team.id}/run-lead`).send({}).expect(501);
    expect(res.body.error.code).toBe("not_configured");
  });

  it("POST /api/teams/:id/run-lead spawns a lead cycle through the coordinator watcher proxy", async () => {
    const spawnLeadCycle = vi.fn(({ projectId }) => ({ ok: true, runId: `run-${projectId}`, taskId: `task-${projectId}` }));
    const watcherHolder = {
      current: {
        handleRunRequested: vi.fn(),
        cancel: vi.fn(),
        shutdown: vi.fn(),
        isActive: vi.fn(),
        getRunLiveInputState: vi.fn(),
        sendRunMessage: vi.fn(),
        maybeAutoStart: vi.fn(),
        maybeAutoStartDependents: vi.fn(),
        maybeScheduleUnassignedTeamTask: vi.fn(),
        spawnLeadCycle,
      },
    };
    const { agent, db } = makeTestServer({ watcher: createWatcherProxy(watcherHolder) });
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at) VALUES ('lead', 'Lead', 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)").run(now, now);
    const { body: { team } } = await agent.post("/api/teams").send({ name: "Proxy Team", lead_agent: "lead" }).expect(201);
    const { body: { project } } = await agent.post("/api/projects").send({ name: "Proxy Project", team_id: team.id }).expect(201);

    const res = await agent.post(`/api/teams/${team.id}/run-lead`).send({ reason: "manual" }).expect(202);
    expect(res.body.results).toEqual([
      expect.objectContaining({ ok: true, project_id: project.id, runId: `run-${project.id}`, taskId: `task-${project.id}` }),
    ]);
    expect(spawnLeadCycle).toHaveBeenCalledWith({ teamId: team.id, projectId: project.id, reason: "manual" });
  });
});
