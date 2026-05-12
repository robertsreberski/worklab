import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";
import { kbCreate } from "../../core/kb.js";

const dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function mkServer() {
  const d = mkdtempSync(join(tmpdir(), "worklab-mentions-api-"));
  dirs.push(d);
  mkdirSync(join(d, "knowledge"), { recursive: true });
  return { ...makeTestServer({ dataDir: d }), dataDir: d };
}

function seedAgent(db, name, displayName) {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)
  `).run(name, displayName, now, now);
}

function seedTask(db, { id, task_key, title }) {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO tasks (id, task_key, root_task_id, title, instructions, stage, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', 'plan', ?, ?)
  `).run(id, task_key, id, title, now, now);
}

function seedProject(db, { id, slug, name }) {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO projects (id, slug, name, archived, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run(id, slug, name, now, now);
}

function seedTeam(db, { id, slug, name }) {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO teams (id, slug, name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(id, slug, name, now, now);
}

function seedSkill(dataDir, { name, displayName }) {
  const dir = join(dataDir, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `display_name: ${displayName}`,
    "trigger: Use for triage tests.",
    "---",
    "",
    "Skill body.",
  ].join("\n"));
}

function seedGoal(db, { id, teamId, projectId, rootTaskId }) {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO goals (id, team_id, project_id, root_task_id, status, contract_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'in_progress', '{}', ?, ?)
  `).run(id, teamId, projectId, rootTaskId, now, now);
}

function seedRun(db, { id, taskId, agentName = "triager" }) {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO task_runs (id, task_id, mode, stage, agent_name, status, process_status, started_at)
    VALUES (?, ?, 'execute', 'execute', ?, 'complete', 'complete', ?)
  `).run(id, taskId, agentName, now);
}

describe("GET /api/mentions/search", () => {
  it("returns 400 when q is missing", async () => {
    const { agent } = mkServer();
    const res = await agent.get("/api/mentions/search").expect(400);
    expect(res.body.error.code).toBe("validation");
  });

  it("returns matching agent, task, project, team, kb, skill, goal, and run results", async () => {
    const { agent, db, dataDir } = mkServer();
    seedAgent(db, "triager", "Triager Bot");
    seedTask(db, { id: "task-uuid-1", task_key: "T-42", title: "Triage support queue" });
    seedProject(db, { id: "proj-1", slug: "triage-app", name: "Triage App" });
    seedTeam(db, { id: "team-1", slug: "triage-team", name: "Triage Team" });
    seedSkill(dataDir, { name: "triage-skill", displayName: "Triage Skill" });
    seedGoal(db, { id: "triage-goal", teamId: "team-1", projectId: "proj-1", rootTaskId: "task-uuid-1" });
    seedRun(db, { id: "triage-run", taskId: "task-uuid-1" });
    kbCreate({
      dataDir,
      slug: "triage-runbook",
      title: "Triage runbook",
      body: "doc",
      author: "human",
    });

    const res = await agent.get("/api/mentions/search?q=triage").expect(200);
    const types = res.body.results.map((r) => r.type);
    expect(types).toContain("agent");
    expect(types).toContain("task");
    expect(types).toContain("project");
    expect(types).toContain("team");
    expect(types).toContain("kb");
    expect(types).toContain("skill");
    expect(types).toContain("goal");
    expect(types).toContain("run");

    for (const result of res.body.results) {
      expect(result.token).toMatch(/^@(agent|task|project|team|kb|skill|goal|run)\//);
      expect(result.label).toBeTypeOf("string");
      expect(result.href).toMatch(/^#\/(tasks|projects|goals|library\/(agents|teams|knowledge|skills))\//);
    }
  });

  it("filters by ?types=", async () => {
    const { agent, db } = mkServer();
    seedAgent(db, "triager", "Triager Bot");
    seedProject(db, { id: "proj-1", slug: "triage", name: "Triage" });

    const res = await agent.get("/api/mentions/search?q=triage&types=agent").expect(200);
    const types = new Set(res.body.results.map((r) => r.type));
    expect(types).toEqual(new Set(["agent"]));
  });

  it("ignores unknown ?types= values and falls back to all types", async () => {
    const { agent, db } = mkServer();
    seedProject(db, { id: "proj-1", slug: "triage", name: "Triage" });
    const res = await agent.get("/api/mentions/search?q=triage&types=foo,bar").expect(200);
    const types = new Set(res.body.results.map((r) => r.type));
    expect(types.has("project")).toBe(true);
  });

  it("ranks exact slug matches above substring matches", async () => {
    const { agent, db } = mkServer();
    seedProject(db, { id: "proj-a", slug: "triage", name: "Triage" });
    seedProject(db, { id: "proj-b", slug: "triage-runbook", name: "Triage Runbook" });
    seedProject(db, { id: "proj-c", slug: "auto-triage", name: "Auto Triage" });

    const res = await agent.get("/api/mentions/search?q=triage&types=project").expect(200);
    expect(res.body.results[0].id).toBe("triage");
  });

  it("caps limit at 25 and uses 8 by default", async () => {
    const { agent } = mkServer();
    const res = await agent.get("/api/mentions/search?q=zzzzzzz&limit=999").expect(200);
    expect(res.body.results.length).toBeLessThanOrEqual(25);
  });

  it("uses the canonical task_key as the mention id when present", async () => {
    const { agent, db } = mkServer();
    seedTask(db, { id: "task-uuid-1", task_key: "T-42", title: "Fix login" });
    const res = await agent.get("/api/mentions/search?q=fix&types=task").expect(200);
    const task = res.body.results.find((r) => r.type === "task");
    expect(task.token).toBe("@task/T-42");
    expect(task.href).toBe("#/tasks/task-uuid-1");
  });

  it("does not expose ids or slugs as labels for unnamed search results", async () => {
    const { agent, db, dataDir } = mkServer();
    seedTask(db, { id: "task-uuid-1", task_key: "T-42", title: "Orphan root task" });
    seedProject(db, { id: "proj-orphan", slug: "orphan-project", name: "" });
    seedTeam(db, { id: "team-orphan", slug: "orphan-team", name: "" });
    seedGoal(db, {
      id: "orphan-goal",
      teamId: "team-orphan",
      projectId: "proj-orphan",
      rootTaskId: "task-uuid-1",
    });
    kbCreate({
      dataDir,
      slug: "orphan-doc",
      title: "",
      body: "doc",
      author: "human",
    });

    const res = await agent.get("/api/mentions/search?q=orphan&types=project,team,kb,goal").expect(200);
    const byType = new Map(res.body.results.map((result) => [result.type, result]));

    expect(byType.get("project")).toMatchObject({ label: "Unknown Project" });
    expect(byType.get("team")).toMatchObject({ label: "Unknown Team" });
    expect(byType.get("kb")).toMatchObject({ label: "Unknown Knowledge" });
    expect(byType.get("goal")).toMatchObject({ label: "Unknown Project", sublabel: "goal" });
  });
});

describe("mentions sidecar on read endpoints", () => {
  it("attaches mentions[] to GET /api/tasks/:id when instructions reference an agent", async () => {
    const { agent, db } = mkServer();
    seedAgent(db, "triager", "Triager Bot");
    seedTask(db, { id: "task-uuid-1", task_key: "T-7", title: "Triage" });
    db.prepare("UPDATE tasks SET instructions = ? WHERE id = ?")
      .run("Hand off to @agent/triager when ready.", "task-uuid-1");

    const res = await agent.get("/api/tasks/task-uuid-1").expect(200);
    expect(res.body.mentions["@agent/triager"]).toMatchObject({
      type: "agent",
      label: "Triager Bot",
      exists: true,
    });
  });

  it("attaches mentions[] to GET /api/tasks/:id from the task plan body", async () => {
    const { agent, db } = mkServer();
    seedAgent(db, "triager", "Triager Bot");
    seedTask(db, { id: "task-uuid-1", task_key: "T-7", title: "Triage" });
    db.prepare("UPDATE tasks SET plan_body = ? WHERE id = ?")
      .run("Plan review with @agent/triager.", "task-uuid-1");

    const res = await agent.get("/api/tasks/task-uuid-1").expect(200);
    expect(res.body.mentions["@agent/triager"]).toMatchObject({
      type: "agent",
      label: "Triager Bot",
      exists: true,
    });
  });

  it("attaches mentions[] to GET /api/projects/:id from project context", async () => {
    const { agent, db } = mkServer();
    seedAgent(db, "triager", "Triager Bot");
    const res = await agent
      .post("/api/projects")
      .send({
        name: "Mobile",
        slug: "mobile",
        context: "Owned by @agent/triager",
      })
      .expect(201);
    const detail = await agent.get(`/api/projects/${res.body.project.id}`).expect(200);
    expect(detail.body.mentions["@agent/triager"].exists).toBe(true);
  });

  it("attaches mentions[] to GET /api/teams/:id from team goal", async () => {
    const { agent, db } = mkServer();
    seedAgent(db, "triager", "Triager Bot");
    const res = await agent
      .post("/api/teams")
      .send({
        name: "Triage",
        slug: "triage",
        goal: "Coordinate with @agent/triager",
      })
      .expect(201);
    const detail = await agent.get(`/api/teams/${res.body.team.id}`).expect(200);
    expect(detail.body.mentions["@agent/triager"].exists).toBe(true);
  });

  it("attaches mentions[] to GET /api/kb/:slug from body", async () => {
    const { agent, db, dataDir } = mkServer();
    seedAgent(db, "triager", "Triager Bot");
    kbCreate({
      dataDir,
      slug: "auth",
      title: "Auth",
      body: "See @agent/triager for the queue",
      author: "human",
    });
    const detail = await agent.get("/api/kb/auth").expect(200);
    expect(detail.body.mentions["@agent/triager"].exists).toBe(true);
  });

  it("attaches mentions[] to GET /api/agents/:name from instructions", async () => {
    const { agent, db } = mkServer();
    db.prepare(`
      INSERT INTO agents (name, display_name, sdk, model, enabled, instructions, created_at, updated_at)
      VALUES ('coder', 'Coder', 'claude', 'claude:claude-sonnet-4-6', 1, 'Defer to @agent/triager', 1, 1)
    `).run();
    seedAgent(db, "triager", "Triager Bot");
    const detail = await agent.get("/api/agents/coder").expect(200);
    expect(detail.body.mentions["@agent/triager"].exists).toBe(true);
  });
});
