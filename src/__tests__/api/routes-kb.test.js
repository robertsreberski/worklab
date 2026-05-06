import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { makeTestServer } from "../helpers/test-server.js";

describe("kb REST routes", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    vi.restoreAllMocks();
  });

  function mkServer() {
    const d = mkdtempSync(join(tmpdir(), "worklab-kb-"));
    dirs.push(d);
    mkdirSync(join(d, "knowledge"), { recursive: true });
    const { app, broker, agent, db } = makeTestServer({ dataDir: d });
    // Spy on broker.broadcast AFTER creating the server so we capture calls.
    vi.spyOn(broker, "broadcast");
    return { agent, dataDir: d, broker, db };
  }

  // ── GET /api/kb ─────────────────────────────────────────────────────────────

  it("GET /api/kb returns empty list when no entries", async () => {
    const { agent } = mkServer();
    const res = await agent.get("/api/kb").expect(200);
    expect(res.body).toEqual({ entries: [] });
  });

  it("GET /api/kb lists entries after creation", async () => {
    const { agent } = mkServer();
    await agent
      .post("/api/kb")
      .send({ slug: "alpha", title: "Alpha Entry", body: "hello" })
      .expect(201);
    const res = await agent.get("/api/kb").expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].slug).toBe("alpha");
    expect(res.body.entries[0].title).toBe("Alpha Entry");
  });

  it("GET /api/kb filters by tag", async () => {
    const { agent } = mkServer();
    await agent.post("/api/kb").send({ slug: "tagged", title: "Tagged", body: "", tags: ["foo"] });
    await agent.post("/api/kb").send({ slug: "untagged", title: "Untagged", body: "", tags: [] });
    const res = await agent.get("/api/kb?tag=foo").expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].slug).toBe("tagged");
  });

  it("GET /api/kb filters by category", async () => {
    const { agent } = mkServer();
    await agent.post("/api/kb").send({ slug: "c1", title: "C1", body: "", category: "howto" });
    await agent.post("/api/kb").send({ slug: "c2", title: "C2", body: "", category: "ref" });
    const res = await agent.get("/api/kb?category=howto").expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].slug).toBe("c1");
  });

  it("GET /api/kb filters by project slug and subcategory", async () => {
    const { agent } = mkServer();
    const project = await agent
      .post("/api/projects")
      .send({ name: "Project One", slug: "project-one" })
      .expect(201);
    await agent
      .post("/api/kb")
      .send({
        slug: "project-entry",
        title: "Project Entry",
        body: "",
        project_id: "project-one",
        category: "research",
        subcategory: "ui-audit",
      })
      .expect(201);
    await agent
      .post("/api/kb")
      .send({
        slug: "other-entry",
        title: "Other Entry",
        body: "",
        category: "research",
        subcategory: "ui-audit",
      })
      .expect(201);

    const res = await agent.get("/api/kb?project_id=project-one&subcategory=ui-audit").expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({
      slug: "project-entry",
      project_id: project.body.project.id,
      project: {
        id: project.body.project.id,
        slug: "project-one",
        name: "Project One",
      },
      subcategory: "ui-audit",
    });
  });

  it("GET /api/kb filters by pinned=true (string coercion)", async () => {
    const { agent } = mkServer();
    await agent.post("/api/kb").send({ slug: "pinned", title: "Pinned", body: "", pinned: true });
    await agent.post("/api/kb").send({ slug: "not-pinned", title: "Not Pinned", body: "" });
    const res = await agent.get("/api/kb?pinned=true").expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].slug).toBe("pinned");
  });

  it("GET /api/kb filters by pinned=false (string coercion)", async () => {
    const { agent } = mkServer();
    await agent.post("/api/kb").send({ slug: "pinned", title: "Pinned", body: "", pinned: true });
    await agent.post("/api/kb").send({ slug: "not-pinned", title: "Not Pinned", body: "" });
    const res = await agent.get("/api/kb?pinned=false").expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].slug).toBe("not-pinned");
  });

  it("GET /api/kb with no pinned param returns all entries", async () => {
    const { agent } = mkServer();
    await agent.post("/api/kb").send({ slug: "pinned", title: "Pinned", body: "", pinned: true });
    await agent.post("/api/kb").send({ slug: "not-pinned", title: "Not Pinned", body: "" });
    const res = await agent.get("/api/kb").expect(200);
    expect(res.body.entries).toHaveLength(2);
  });

  // ── GET /api/kb/:slug ───────────────────────────────────────────────────────

  it("GET /api/kb/:slug returns the entry with meta and body", async () => {
    const { agent } = mkServer();
    await agent.post("/api/kb").send({ slug: "my-entry", title: "My Entry", body: "content here" });
    const res = await agent.get("/api/kb/my-entry").expect(200);
    expect(res.body.entry.meta.slug).toBe("my-entry");
    expect(res.body.entry.meta.title).toBe("My Entry");
    expect(res.body.entry.body).toContain("content here");
  });

  it("GET /api/kb/:slug returns 404 for missing entry", async () => {
    const { agent } = mkServer();
    const res = await agent.get("/api/kb/not-here").expect(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("GET /api/kb/:slug returns 400 for invalid slug", async () => {
    const { agent } = mkServer();
    const res = await agent.get("/api/kb/INVALID_SLUG").expect(400);
    expect(res.body.error.code).toBe("invalid_slug");
  });

  it("POST /api/kb/organize previews and applies project/category metadata", async () => {
    const { agent, db } = mkServer();
    const project = await agent
      .post("/api/projects")
      .send({ name: "Project One", slug: "project-one" })
      .expect(201);
    await agent
      .post("/api/kb")
      .send({ slug: "runtime-note", title: "Runtime audit note", body: "body", tags: ["runtime", "audit"] })
      .expect(201);
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks
        (id, task_key, root_task_id, project_id, title, instructions, stage, run_policy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'done', 'manual', ?, ?)
    `).run(
      "task-1",
      "T-1",
      "task-1",
      project.body.project.id,
      "Runtime audit",
      "See #/knowledge/runtime-note for the durable audit.",
      now,
      now,
    );

    const preview = await agent.post("/api/kb/organize").send({ apply: false }).expect(200);
    expect(preview.body.apply).toBe(false);
    expect(preview.body.proposals).toContainEqual(expect.objectContaining({
      slug: "runtime-note",
      patch: expect.objectContaining({
        project_id: project.body.project.id,
        category: "research",
        subcategory: "runtime",
      }),
    }));

    const before = await agent.get("/api/kb/runtime-note").expect(200);
    expect(before.body.entry.meta.project_id).toBeNull();

    const applied = await agent.post("/api/kb/organize").send({ apply: true }).expect(200);
    expect(applied.body.apply).toBe(true);
    expect(applied.body.applied).toBeGreaterThan(0);
    const after = await agent.get("/api/kb/runtime-note").expect(200);
    expect(after.body.entry.meta.project_id).toBe(project.body.project.id);
    expect(after.body.entry.meta.category).toBe("research");
    expect(after.body.entry.meta.subcategory).toBe("runtime");
  });

  it("POST /api/kb/cleanup-auto-promoted previews and removes only generated run-result assets", async () => {
    const { agent, db, broker } = mkServer();
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks
        (id, task_key, root_task_id, title, instructions, stage, run_policy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'done', 'manual', ?, ?)
    `).run("task-1", "T-1", "task-1", "Generated task", "", now, now);
    db.prepare(`
      INSERT INTO task_runs
        (id, task_id, mode, stage, agent_name, status, process_status, started_at, ended_at)
      VALUES (?, ?, 'execute', 'execute', 'coder', 'succeeded', 'succeeded', ?, ?)
    `).run("RunABC", "task-1", now, now);

    const generatedBody = [
      "Source task: [T-1 - Generated task](#/tasks/T-1)",
      "Source run: [RunABC](/api/runs/RunABC/raw-log)",
      "Stage: execute",
      "Agent: coder",
      "",
      "---",
      "",
      "Auto-promoted final answer.",
    ].join("\n");
    await agent
      .post("/api/kb")
      .send({
        slug: "run-runabc",
        title: "T-1 final answer from coder",
        body: generatedBody,
        category: "run-results",
        tags: ["run-result", "execute", "agent-coder"],
      })
      .expect(201);
    await agent
      .post("/api/kb")
      .send({
        slug: "pinned-run",
        title: "Pinned generated run",
        body: generatedBody,
        category: "run-results",
        tags: ["run-result"],
        pinned: true,
      })
      .expect(201);
    await agent
      .post("/api/kb")
      .send({
        slug: "daily-digest",
        title: "Daily Digest",
        body: "# Daily Digest\n\nCurated and reusable.",
        category: "run-results",
        tags: ["daily-catchup"],
      })
      .expect(201);

    const preview = await agent.post("/api/kb/cleanup-auto-promoted").send({ apply: false }).expect(200);
    expect(preview.body).toMatchObject({ ok: true, apply: false, proposed: 1, deleted: 0 });
    expect(preview.body.candidates).toEqual([
      expect.objectContaining({
        slug: "run-runabc",
        source_run_id: "RunABC",
        source_task_ref: "T-1",
        source_run_exists: true,
      }),
    ]);
    await agent.get("/api/kb/run-runabc").expect(200);

    broker.broadcast.mockClear();
    const applied = await agent.post("/api/kb/cleanup-auto-promoted").send({ apply: true }).expect(200);
    expect(applied.body).toMatchObject({ ok: true, apply: true, proposed: 1, deleted: 1 });
    await agent.get("/api/kb/run-runabc").expect(404);
    await agent.get("/api/kb/pinned-run").expect(200);
    await agent.get("/api/kb/daily-digest").expect(200);
    expect(broker.broadcast).toHaveBeenCalledWith("global", {
      type: "kb_updated",
      slug: "run-runabc",
    });
  });

  // ── POST /api/kb ────────────────────────────────────────────────────────────

  it("POST /api/kb creates an entry and returns 201", async () => {
    const { agent } = mkServer();
    const res = await agent
      .post("/api/kb")
      .send({ slug: "new-entry", title: "New Entry", body: "body text" })
      .expect(201);
    expect(res.body.entry.meta.slug).toBe("new-entry");
    expect(res.body.entry.meta.title).toBe("New Entry");
    expect(res.body.entry.meta.author).toBe("human");
  });

  it("POST /api/kb generates a unique slug from title when slug is omitted", async () => {
    const { agent } = mkServer();
    const first = await agent
      .post("/api/kb")
      .send({ title: "Generated Entry", body: "" })
      .expect(201);
    const second = await agent
      .post("/api/kb")
      .send({ title: "Generated Entry", body: "" })
      .expect(201);

    expect(first.body.entry.meta.slug).toBe("generated-entry");
    expect(second.body.entry.meta.slug).toBe("generated-entry-2");
  });

  it("POST /api/kb hardcodes author=human", async () => {
    const { agent } = mkServer();
    const res = await agent
      .post("/api/kb")
      .send({ slug: "author-test", title: "Author Test", body: "", author: "agent" })
      .expect(201);
    // Even if the client sends author: "agent", the route must override to "human"
    expect(res.body.entry.meta.author).toBe("human");
  });

  it("POST /api/kb with optional fields (tags, category, pinned)", async () => {
    const { agent } = mkServer();
    const res = await agent
      .post("/api/kb")
      .send({
        slug: "full-entry",
        title: "Full Entry",
        body: "body",
        tags: ["a", "b"],
        category: "ref",
        pinned: true,
      })
      .expect(201);
    expect(res.body.entry.meta.tags).toEqual(["a", "b"]);
    expect(res.body.entry.meta.category).toBe("ref");
    expect(res.body.entry.meta.pinned).toBe(true);
  });

  it("POST /api/kb resolves project slug and stores subcategory", async () => {
    const { agent } = mkServer();
    const project = await agent
      .post("/api/projects")
      .send({ name: "Project One", slug: "project-one" })
      .expect(201);
    const res = await agent
      .post("/api/kb")
      .send({
        slug: "project-meta",
        title: "Project Meta",
        body: "body",
        project_id: "project-one",
        subcategory: "runtime",
      })
      .expect(201);
    expect(res.body.entry.meta.project_id).toBe(project.body.project.id);
    expect(res.body.entry.meta.subcategory).toBe("runtime");
    expect(res.body.entry.project.slug).toBe("project-one");
  });

  it("POST /api/kb returns 409 when slug already exists", async () => {
    const { agent } = mkServer();
    await agent.post("/api/kb").send({ slug: "dup", title: "Dup", body: "" }).expect(201);
    const res = await agent.post("/api/kb").send({ slug: "dup", title: "Dup 2", body: "" }).expect(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("POST /api/kb returns 400 when title is missing", async () => {
    const { agent } = mkServer();
    const res = await agent.post("/api/kb").send({ slug: "no-title", body: "" }).expect(400);
    expect(res.body.error.code).toBe("validation");
  });

  it("POST /api/kb returns 400 for invalid slug format", async () => {
    const { agent } = mkServer();
    const res = await agent
      .post("/api/kb")
      .send({ slug: "UPPER_CASE", title: "Bad Slug", body: "" })
      .expect(400);
    expect(res.body.error.code).toBe("invalid_slug");
  });

  it("POST /api/kb broadcasts kb_updated", async () => {
    const { agent, broker } = mkServer();
    await agent.post("/api/kb").send({ slug: "broadcast-test", title: "Broadcast", body: "" });
    expect(broker.broadcast).toHaveBeenCalledWith("global", {
      type: "kb_updated",
      slug: "broadcast-test",
    });
  });

  // ── PATCH /api/kb/:slug ─────────────────────────────────────────────────────

  it("PATCH /api/kb/:slug updates the entry", async () => {
    const { agent } = mkServer();
    await agent.post("/api/kb").send({ slug: "patch-me", title: "Old Title", body: "old body" });
    const res = await agent
      .patch("/api/kb/patch-me")
      .send({ title: "New Title", body: "new body" })
      .expect(200);
    expect(res.body.entry.meta.title).toBe("New Title");
    expect(res.body.entry.body).toContain("new body");
  });

  it("PATCH /api/kb/:slug supports partial update (body only)", async () => {
    const { agent } = mkServer();
    await agent.post("/api/kb").send({ slug: "patch-body", title: "Stay Same", body: "old" });
    const res = await agent.patch("/api/kb/patch-body").send({ body: "updated" }).expect(200);
    expect(res.body.entry.meta.title).toBe("Stay Same");
    expect(res.body.entry.body).toContain("updated");
  });

  it("PATCH /api/kb/:slug returns 404 for missing entry", async () => {
    const { agent } = mkServer();
    const res = await agent.patch("/api/kb/missing").send({ title: "X" }).expect(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("PATCH /api/kb/:slug returns 400 for invalid slug", async () => {
    const { agent } = mkServer();
    const res = await agent.patch("/api/kb/INVALID").send({ title: "X" }).expect(400);
    expect(res.body.error.code).toBe("invalid_slug");
  });

  it("PATCH /api/kb/:slug broadcasts kb_updated", async () => {
    const { agent, broker } = mkServer();
    await agent.post("/api/kb").send({ slug: "patch-broadcast", title: "T", body: "" });
    broker.broadcast.mockClear();
    await agent.patch("/api/kb/patch-broadcast").send({ title: "Updated" });
    expect(broker.broadcast).toHaveBeenCalledWith("global", {
      type: "kb_updated",
      slug: "patch-broadcast",
    });
  });

  it("PATCH /api/kb/:slug strips unknown fields (author, created_at)", async () => {
    const { agent } = mkServer();
    // Create entry with author="human"
    const createRes = await agent
      .post("/api/kb")
      .send({ slug: "author-safety", title: "Original", body: "original body" })
      .expect(201);
    const originalAuthor = createRes.body.entry.meta.author;
    const originalCreatedAt = createRes.body.entry.meta.created_at;
    expect(originalAuthor).toBe("human");

    // Try to patch with evil author and created_at
    const patchRes = await agent
      .patch("/api/kb/author-safety")
      .send({
        title: "Updated",
        author: "evil",
        created_at: "1970-01-01T00:00:00Z",
      })
      .expect(200);
    expect(patchRes.body.entry.meta.author).toBe("human");
    expect(patchRes.body.entry.meta.created_at).toBe(originalCreatedAt);

    // Verify subsequent GET also shows original author and created_at
    const getRes = await agent.get("/api/kb/author-safety").expect(200);
    expect(getRes.body.entry.meta.author).toBe("human");
    expect(getRes.body.entry.meta.created_at).toBe(originalCreatedAt);
  });

  // ── GET /api/kb/:slug/usage ────────────────────────────────────────────────

  it("GET /api/kb/:slug/usage scans task titles and instructions", async () => {
    const { agent } = mkServer();
    await agent
      .post("/api/kb")
      .send({ slug: "search-guide", title: "Search Guide", body: "Use this for search work." })
      .expect(201);
    const taskRes = await agent
      .post("/api/tasks")
      .send({
        title: "Use Search Guide",
        instructions: "Follow search-guide before changing the index.",
      })
      .expect(201);

    const res = await agent.get("/api/kb/search-guide/usage").expect(200);
    expect(res.body.tasks).toEqual([
      {
        id: taskRes.body.task.id,
        task_key: taskRes.body.task.task_key,
        title: "Use Search Guide",
        stage: "plan",
        via: "body",
      },
    ]);
  });

  // ── DELETE /api/kb/:slug ────────────────────────────────────────────────────

  it("DELETE /api/kb/:slug returns 204", async () => {
    const { agent } = mkServer();
    await agent.post("/api/kb").send({ slug: "del-me", title: "Del Me", body: "" });
    await agent.delete("/api/kb/del-me").expect(204);
    // Entry should be gone
    await agent.get("/api/kb/del-me").expect(404);
  });

  it("DELETE /api/kb/:slug returns 404 for missing entry", async () => {
    const { agent } = mkServer();
    const res = await agent.delete("/api/kb/not-here").expect(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("DELETE /api/kb/:slug returns 400 for invalid slug", async () => {
    const { agent } = mkServer();
    const res = await agent.delete("/api/kb/INVALID").expect(400);
    expect(res.body.error.code).toBe("invalid_slug");
  });

  it("DELETE /api/kb/:slug broadcasts kb_updated", async () => {
    const { agent, broker } = mkServer();
    await agent.post("/api/kb").send({ slug: "del-broadcast", title: "T", body: "" });
    broker.broadcast.mockClear();
    await agent.delete("/api/kb/del-broadcast");
    expect(broker.broadcast).toHaveBeenCalledWith("global", {
      type: "kb_updated",
      slug: "del-broadcast",
    });
  });
});
