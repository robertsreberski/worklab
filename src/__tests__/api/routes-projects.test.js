import { describe, expect, it } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("project API", () => {
  it("creates, lists, updates, reads, and archives projects", async () => {
    const { agent } = makeTestServer();

    const created = await agent.post("/api/projects").send({
      name: "Mobile App",
      description: "Customer app",
      context: "Use the mobile design system.",
      workdir: "relative-mobile",
      tags: ["ios", "mobile"],
    }).expect(201);

    expect(created.body.project).toMatchObject({
      slug: "mobile-app",
      name: "Mobile App",
      description: "Customer app",
      context: "Use the mobile design system.",
      tags: ["ios", "mobile"],
      archived: false,
    });
    expect(created.body.project.workdir).toMatch(/relative-mobile$/);

    const list = await agent.get("/api/projects").expect(200);
    expect(list.body.projects.map((project) => project.slug)).toEqual(["mobile-app"]);

    const patched = await agent.patch(`/api/projects/${created.body.project.slug}`).send({
      name: "Mobile Surface",
      context: "Updated project context.",
      archived: false,
    }).expect(200);
    expect(patched.body.project).toMatchObject({
      slug: "mobile-app",
      name: "Mobile Surface",
      context: "Updated project context.",
    });

    const detail = await agent.get(`/api/projects/${created.body.project.id}`).expect(200);
    expect(detail.body.project.stats).toMatchObject({ task_count: 0, by_stage: {} });

    await agent.delete(`/api/projects/${created.body.project.id}`).expect(204);
    expect((await agent.get("/api/projects").expect(200)).body.projects).toEqual([]);
    const archived = await agent.get("/api/projects?include_archived=true").expect(200);
    expect(archived.body.projects[0]).toMatchObject({ id: created.body.project.id, archived: true });
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
});
