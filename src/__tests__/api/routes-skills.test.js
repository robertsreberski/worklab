import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { makeTestDb } from "../helpers/test-db.js";
import { createServer } from "../../api/server.js";

describe("skills CRUD", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function mkServer() {
    const d = mkdtempSync(join(tmpdir(), "worklab-skills-"));
    dirs.push(d);
    mkdirSync(join(d, "skills"), { recursive: true });
    const db = makeTestDb();
    const { app } = createServer({ db, logger: undefined, watcher: undefined, dataDir: d });
    return { agent: supertest(app), dataDir: d };
  }

  it("GET /api/skills lists filesystem entries", async () => {
    const { agent, dataDir } = mkServer();
    mkdirSync(join(dataDir, "skills", "alpha"));
    writeFileSync(
      join(dataDir, "skills", "alpha", "SKILL.md"),
      `---\nname: alpha\ntrigger: "when alpha"\n---\nbody-alpha`
    );
    const res = await agent.get("/api/skills").expect(200);
    expect(res.body.skills.length).toBe(1);
    expect(res.body.skills[0].name).toBe("alpha");
    expect(res.body.skills[0].display_name).toBe("");
  });

  it("POST /api/skills creates folder + SKILL.md", async () => {
    const { agent, dataDir } = mkServer();
    const res = await agent
      .post("/api/skills")
      .send({ name: "new-skill", meta: { trigger: "when new", enabled: true }, body: "playbook" })
      .expect(201);
    expect(res.body.skill.name).toBe("new-skill");
    expect(existsSync(join(dataDir, "skills", "new-skill", "SKILL.md"))).toBe(true);
    const content = readFileSync(join(dataDir, "skills", "new-skill", "SKILL.md"), "utf8");
    expect(content).toMatch(/trigger:/);
    expect(content).toMatch(/playbook/);
  });

  it("POST /api/skills generates a folder slug from display_name when name is omitted", async () => {
    const { agent, dataDir } = mkServer();
    const res = await agent
      .post("/api/skills")
      .send({ meta: { display_name: "Research Planner", trigger: "when planning" }, body: "playbook" })
      .expect(201);

    expect(res.body.skill.name).toBe("research-planner");
    expect(res.body.skill.meta.display_name).toBe("Research Planner");
    expect(existsSync(join(dataDir, "skills", "research-planner", "SKILL.md"))).toBe(true);
  });

  it("POST rejects duplicate name", async () => {
    const { agent, dataDir } = mkServer();
    mkdirSync(join(dataDir, "skills", "dup"));
    writeFileSync(join(dataDir, "skills", "dup", "SKILL.md"), `---\nname: dup\ntrigger: x\n---\n`);
    await agent
      .post("/api/skills")
      .send({ name: "dup", meta: { trigger: "x" }, body: "" })
      .expect(409);
  });

  it("PATCH rewrites SKILL.md", async () => {
    const { agent, dataDir } = mkServer();
    await agent
      .post("/api/skills")
      .send({ name: "s", meta: { trigger: "t", enabled: true }, body: "old" });
    await agent
      .patch("/api/skills/s")
      .send({ meta: { trigger: "t2", enabled: true }, body: "new" })
      .expect(200);
    const content = readFileSync(join(dataDir, "skills", "s", "SKILL.md"), "utf8");
    expect(content).toMatch(/trigger: t2/);
    expect(content).toMatch(/new/);
  });

  it("DELETE removes the skill folder", async () => {
    const { agent, dataDir } = mkServer();
    await agent
      .post("/api/skills")
      .send({ name: "bye", meta: { trigger: "t" }, body: "" });
    expect(existsSync(join(dataDir, "skills", "bye"))).toBe(true);
    await agent.delete("/api/skills/bye").expect(204);
    expect(existsSync(join(dataDir, "skills", "bye"))).toBe(false);
  });

  it("validates slug name", async () => {
    const { agent } = mkServer();
    await agent
      .post("/api/skills")
      .send({ name: "has spaces", meta: { trigger: "x" }, body: "" })
      .expect(400);
  });
});
