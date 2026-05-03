import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

const cleanupDirs = [];

function tempWorkdir(name) {
  const root = mkdtempSync(join(tmpdir(), "worklab-project-api-"));
  cleanupDirs.push(root);
  return join(root, name);
}

describe("project API", () => {
  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates, lists, updates, reads, and archives projects", async () => {
    const { agent } = makeTestServer();
    const workdir = tempWorkdir("mobile-app");

    const created = await agent.post("/api/projects").send({
      name: "Mobile App",
      description: "Customer app",
      context: "Use the mobile design system.",
      workdir,
      worktree_mode: "auto",
      tags: ["ios", "mobile"],
    }).expect(201);

    expect(created.body.project).toMatchObject({
      slug: "mobile-app",
      name: "Mobile App",
      description: "Customer app",
      context: "Use the mobile design system.",
      tags: ["ios", "mobile"],
      archived: false,
      workdir,
      worktree_mode: "auto",
    });
    expect(existsSync(workdir)).toBe(true);

    const list = await agent.get("/api/projects").expect(200);
    expect(list.body.projects.map((project) => project.slug)).toEqual(["mobile-app"]);

    const patched = await agent.patch(`/api/projects/${created.body.project.slug}`).send({
      name: "Mobile Surface",
      context: "Updated project context.",
      worktree_mode: "required",
      archived: false,
    }).expect(200);
    expect(patched.body.project).toMatchObject({
      slug: "mobile-app",
      name: "Mobile Surface",
      context: "Updated project context.",
      worktree_mode: "required",
    });

    const detail = await agent.get(`/api/projects/${created.body.project.id}`).expect(200);
    expect(detail.body.project.stats).toMatchObject({ task_count: 0, by_stage: {} });
    expect(detail.body.project.worktree_mode).toBe("required");

    await agent.delete(`/api/projects/${created.body.project.id}`).expect(204);
    expect((await agent.get("/api/projects").expect(200)).body.projects).toEqual([]);
    const archived = await agent.get("/api/projects?include_archived=true").expect(200);
    expect(archived.body.projects[0]).toMatchObject({ id: created.body.project.id, archived: true });
  });

  it("rejects relative project workdirs", async () => {
    const { agent } = makeTestServer();
    const response = await agent.post("/api/projects").send({
      name: "Relative Project",
      workdir: "relative-mobile",
    }).expect(400);

    expect(response.body.error).toMatchObject({
      code: "validation",
      message: "workdir must use an absolute path or ~/path",
    });
  });

  it("rejects invalid project worktree modes", async () => {
    const { agent } = makeTestServer();
    const response = await agent.post("/api/projects").send({
      name: "Bad Worktree Mode",
      worktree_mode: "sometimes",
    }).expect(400);

    expect(response.body.error).toMatchObject({
      code: "validation",
      message: "worktree_mode must be one of: off, auto, required",
    });
  });

  it("creates a project workdir when updating", async () => {
    const { agent } = makeTestServer();
    const created = await agent.post("/api/projects").send({ name: "Update Workdir" }).expect(201);
    const workdir = tempWorkdir("patched-project");

    const patched = await agent.patch(`/api/projects/${created.body.project.id}`).send({ workdir }).expect(200);

    expect(patched.body.project.workdir).toBe(workdir);
    expect(existsSync(workdir)).toBe(true);
  });

  it("deduplicates generated slugs", async () => {
    const { agent } = makeTestServer();
    const first = await agent.post("/api/projects").send({ name: "Client Portal" }).expect(201);
    const second = await agent.post("/api/projects").send({ name: "Client Portal" }).expect(201);
    expect(first.body.project.slug).toBe("client-portal");
    expect(second.body.project.slug).toBe("client-portal-2");
  });

  it("auto-suffixes a clashing slug on rename instead of failing", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/projects").send({ name: "Alpha", slug: "alpha" }).expect(201);
    const beta = await agent.post("/api/projects").send({ name: "Beta", slug: "beta" }).expect(201);
    const renamed = await agent
      .patch(`/api/projects/${beta.body.project.id}`)
      .send({ slug: "alpha" })
      .expect(200);
    expect(renamed.body.project.slug).toBe("alpha-2");
  });

  it("includes project task progress and attention fields", async () => {
    const { agent, db } = makeTestServer();
    const { body: { project } } = await agent.post("/api/projects").send({ name: "Progress View" }).expect(201);
    const { body: { task: runningTask } } = await agent.post("/api/tasks").send({
      title: "Running task",
      project_id: project.id,
      stage: "execute",
    }).expect(201);
    const { body: { task: blocker } } = await agent.post("/api/tasks").send({ title: "External blocker" }).expect(201);
    const { body: { task: attentionTask } } = await agent.post("/api/tasks").send({
      title: "Needs attention",
      project_id: project.id,
      stage: "awaiting_user",
      blocked_by_ids: [blocker.id],
    }).expect(201);
    const now = Date.now();
    db.prepare(`
      UPDATE tasks
      SET
        pending_actions_json = ?,
        blocking_issues_json = ?,
        failure_count = 2,
        rejection_streak = 1,
        last_failure_kind = 'review_rejected',
        error_text = 'needs a human decision',
        stage_reason = 'confirm release gate'
      WHERE id = ?
    `).run(
      JSON.stringify(["confirm release"]),
      JSON.stringify(["missing approval"]),
      attentionTask.id,
    );
    db.prepare(`
      INSERT INTO task_runs
        (id, task_id, project_id, mode, stage, agent_name, started_at, status, process_status)
      VALUES ('run-active', ?, ?, 'execute', 'execute', 'builder', ?, 'running', 'running')
    `).run(runningTask.id, project.id, now);
    db.prepare(`
      INSERT INTO task_runs
        (id, task_id, project_id, mode, stage, agent_name, started_at, ended_at, status, process_status, failure_kind, decision, summary)
      VALUES ('run-failed', ?, ?, 'execute', 'execute', 'builder', ?, ?, 'error', 'failed', 'spawn', 'failed', 'worker failed')
    `).run(attentionTask.id, project.id, now - 2_000, now - 1_000);

    const detail = await agent.get(`/api/projects/${project.id}`).expect(200);
    const running = detail.body.project.tasks.find((task) => task.id === runningTask.id);
    const attention = detail.body.project.tasks.find((task) => task.id === attentionTask.id);

    expect(running).toMatchObject({
      id: runningTask.id,
      stage: "execute",
      running_run_id: "run-active",
      running_run: { id: "run-active", process_status: "running" },
    });
    expect(attention).toMatchObject({
      id: attentionTask.id,
      stage: "awaiting_user",
      stage_reason: "confirm release gate",
      pending_actions: ["confirm release"],
      blocking_issues: ["missing approval"],
      failure_count: 2,
      rejection_streak: 1,
      last_failure_kind: "review_rejected",
      error_text: "needs a human decision",
      unresolved_dependency_count: 1,
      last_run: {
        id: "run-failed",
        process_status: "failed",
        failure_kind: "spawn",
        decision: "failed",
        summary: "worker failed",
      },
    });
  });
});
