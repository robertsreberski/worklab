import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDataFromTemplate, seedDefaultAgents } from "../../core/first-boot.js";
import { makeTestDb } from "../helpers/test-db.js";

describe("seedDataFromTemplate", () => {
  const created = [];
  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  function mkDir(name) {
    const p = mkdtempSync(join(tmpdir(), `worklab-fb-${name}-`));
    created.push(p);
    return p;
  }

  it("copies template files when data dir is missing", () => {
    const template = mkDir("tpl");
    const data = join(mkDir("parent"), "data");
    mkdirSync(join(template, "knowledge"), { recursive: true });
    writeFileSync(join(template, "knowledge", "welcome.md"), "hello");
    seedDataFromTemplate({ templateDir: template, dataDir: data });
    expect(existsSync(join(data, "knowledge", "welcome.md"))).toBe(true);
    expect(readFileSync(join(data, "knowledge", "welcome.md"), "utf8")).toBe("hello");
  });

  it("is a no-op when data dir already exists and is non-empty", () => {
    const template = mkDir("tpl2");
    const data = mkDir("data2");
    mkdirSync(join(template, "knowledge"), { recursive: true });
    writeFileSync(join(template, "knowledge", "welcome.md"), "template");
    writeFileSync(join(data, "existing.txt"), "mine");
    seedDataFromTemplate({ templateDir: template, dataDir: data });
    expect(existsSync(join(data, "knowledge", "welcome.md"))).toBe(false);
    expect(readFileSync(join(data, "existing.txt"), "utf8")).toBe("mine");
  });
});

describe("seedDefaultAgents", () => {
  const created = [];
  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  function mkSeedDir(defs) {
    const root = mkdtempSync(join(tmpdir(), "worklab-seed-"));
    created.push(root);
    const seedDir = join(root, "agents", "_seed");
    mkdirSync(seedDir, { recursive: true });
    for (const def of defs) {
      writeFileSync(join(seedDir, `${def.name}.json`), JSON.stringify(def));
    }
    return root;
  }

  it("inserts default agents that don't already exist", () => {
    const db = makeTestDb();
    const templateDir = mkSeedDir([
      { name: "planner", display_name: "Planner", sdk: "claude", model: "claude:claude-opus-4-7", instructions: "plan it" },
      { name: "executor", display_name: "Executor", sdk: "claude", model: "claude:claude-sonnet-4-6", instructions: "do it" },
    ]);
    const result = seedDefaultAgents({ db, templateDir });
    expect(result.seeded).toBe(2);
    const rows = db.prepare("SELECT name, display_name, sdk, model FROM agents ORDER BY name").all();
    expect(rows).toEqual([
      { name: "executor", display_name: "Executor", sdk: "claude", model: "claude:claude-sonnet-4-6" },
      { name: "planner", display_name: "Planner", sdk: "claude", model: "claude:claude-opus-4-7" },
    ]);
  });

  it("skips agents that already exist (idempotent)", () => {
    const db = makeTestDb();
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("planner", "User Planner", "claude", "claude:claude-haiku-4-5", "user-customised", now, now);
    const templateDir = mkSeedDir([
      { name: "planner", display_name: "Default Planner", sdk: "claude", model: "claude:claude-opus-4-7", instructions: "default" },
      { name: "executor", display_name: "Executor", sdk: "claude", model: "claude:claude-sonnet-4-6", instructions: "do it" },
    ]);
    const result = seedDefaultAgents({ db, templateDir });
    expect(result.seeded).toBe(1);
    expect(result.skipped).toContain("planner");
    const planner = db.prepare("SELECT display_name, instructions FROM agents WHERE name = 'planner'").get();
    expect(planner.display_name).toBe("User Planner");
    expect(planner.instructions).toBe("user-customised");
  });

  it("returns gracefully when seed dir is missing", () => {
    const db = makeTestDb();
    const root = mkdtempSync(join(tmpdir(), "worklab-noseed-"));
    created.push(root);
    const result = seedDefaultAgents({ db, templateDir: root });
    expect(result.seeded).toBe(0);
    expect(result.reason).toBe("no-seed-dir");
  });
});
