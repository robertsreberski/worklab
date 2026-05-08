import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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

describe("GET /api/mentions/search", () => {
  it("returns 400 when q is missing", async () => {
    const { agent } = mkServer();
    const res = await agent.get("/api/mentions/search").expect(400);
    expect(res.body.error.code).toBe("validation");
  });

  it("returns matching agent, task, project, team, and kb results", async () => {
    const { agent, db, dataDir } = mkServer();
    seedAgent(db, "triager", "Triager Bot");
    seedTask(db, { id: "task-uuid-1", task_key: "T-42", title: "Triage support queue" });
    seedProject(db, { id: "proj-1", slug: "triage-app", name: "Triage App" });
    seedTeam(db, { id: "team-1", slug: "triage-team", name: "Triage Team" });
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

    for (const result of res.body.results) {
      expect(result.token).toMatch(/^@(agent|task|project|team|kb)\//);
      expect(result.label).toBeTypeOf("string");
      expect(result.href).toMatch(/^#\/(agents|tasks|projects|teams|knowledge)\//);
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
});
