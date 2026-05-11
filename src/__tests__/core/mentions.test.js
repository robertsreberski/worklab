import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kbCreate } from "../../core/kb.js";
import {
  expandMentionsForLlm,
  parseMentionToken,
  parseMentions,
  resolveMentions,
  resolvedMentionsToObject,
  serializeMention,
  uniqueMentionTokens,
} from "../../core/mentions/index.js";
import { makeTestDb } from "../helpers/test-db.js";

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeKbDir() {
  const dir = mkdtempSync(join(tmpdir(), "worklab-mentions-"));
  tempDirs.push(dir);
  return dir;
}

function seedAgent(db, name, displayName = null) {
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

describe("parseMentions", () => {
  it("returns an empty array for plain text", () => {
    expect(parseMentions("hello world")).toEqual([]);
  });

  it("captures token, type, id, and offsets", () => {
    const text = "Hey @agent/triager handle @task/T-42 thanks";
    expect(parseMentions(text)).toEqual([
      { token: "@agent/triager", type: "agent", id: "triager", start: 4, end: 18 },
      { token: "@task/T-42", type: "task", id: "T-42", start: 26, end: 36 },
    ]);
  });

  it("ignores email-style @ in the middle of a word", () => {
    expect(parseMentions("contact admin@agent/x for help")).toEqual([]);
  });

  it("ignores doubled @@ prefixes", () => {
    expect(parseMentions("@@agent/x")).toEqual([]);
  });

  it("does not match unknown types", () => {
    expect(parseMentions("see @user/foo")).toEqual([]);
  });

  it("does not bleed across tokens when called repeatedly", () => {
    const text = "@agent/a and @agent/b";
    expect(parseMentions(text).map((m) => m.token)).toEqual(["@agent/a", "@agent/b"]);
    expect(parseMentions(text).map((m) => m.token)).toEqual(["@agent/a", "@agent/b"]);
  });
});

describe("uniqueMentionTokens", () => {
  it("dedupes repeated tokens", () => {
    expect(uniqueMentionTokens("@agent/a then @agent/a again")).toEqual(["@agent/a"]);
  });
});

describe("serializeMention + parseMentionToken", () => {
  it("round-trips a valid mention", () => {
    const token = serializeMention({ type: "task", id: "T-42" });
    expect(token).toBe("@task/T-42");
    expect(parseMentionToken(token)).toEqual({ token, type: "task", id: "T-42" });
  });

  it("rejects unknown types", () => {
    expect(() => serializeMention({ type: "person", id: "x" })).toThrow(/unknown mention type/);
  });

  it("rejects empty ids", () => {
    expect(() => serializeMention({ type: "agent", id: "" })).toThrow(/non-empty/);
  });

  it("returns null for malformed tokens", () => {
    expect(parseMentionToken("@notatype/x")).toBeNull();
    expect(parseMentionToken("agent/x")).toBeNull();
    expect(parseMentionToken(null)).toBeNull();
  });
});

describe("resolveMentions", () => {
  it("returns an empty map for empty input", () => {
    const db = makeTestDb();
    expect(resolveMentions(db, "").size).toBe(0);
    expect(resolveMentions(db, []).size).toBe(0);
  });

  it("resolves agent, task, project, team, and kb tokens with display labels", () => {
    const db = makeTestDb();
    const dataDir = makeKbDir();
    seedAgent(db, "triager", "Triager Bot");
    seedTask(db, { id: "task-uuid-1", task_key: "T-42", title: "Fix login bug" });
    seedProject(db, { id: "proj-uuid-1", slug: "p-mobile", name: "Mobile App" });
    seedTeam(db, { id: "team-uuid-1", slug: "t-platform", name: "Platform" });
    kbCreate({
      dataDir,
      slug: "auth-flow",
      title: "Auth flow",
      body: "doc",
      author: "human",
      now: new Date("2026-04-22T10:00:00Z"),
    });

    const text = "Hey @agent/triager, look at @task/T-42 in @project/p-mobile for @team/t-platform per @kb/auth-flow";
    const resolved = resolveMentions(db, text, { dataDir });

    expect(resolved.get("@agent/triager")).toMatchObject({
      type: "agent",
      label: "Triager Bot",
      href: "#/library/agents/triager",
      exists: true,
    });
    expect(resolved.get("@task/T-42")).toMatchObject({
      type: "task",
      label: "T-42 Fix login bug",
      href: "#/tasks/task-uuid-1",
      exists: true,
    });
    expect(resolved.get("@project/p-mobile")).toMatchObject({
      type: "project",
      label: "Mobile App",
      href: "#/projects/proj-uuid-1",
      exists: true,
    });
    expect(resolved.get("@team/t-platform")).toMatchObject({
      type: "team",
      label: "Platform",
      href: "#/library/teams/team-uuid-1",
      exists: true,
    });
    expect(resolved.get("@kb/auth-flow")).toMatchObject({
      type: "kb",
      label: "Auth flow",
      href: "#/library/knowledge/auth-flow",
      exists: true,
    });
  });

  it("resolves a task by uuid as well as task_key", () => {
    const db = makeTestDb();
    seedTask(db, { id: "task-uuid-1", task_key: "T-42", title: "Fix login bug" });

    const byUuid = resolveMentions(db, "@task/task-uuid-1");
    expect(byUuid.get("@task/task-uuid-1").exists).toBe(true);
    expect(byUuid.get("@task/task-uuid-1").href).toBe("#/tasks/task-uuid-1");
  });

  it("falls back to humanizing the slug when an agent has an empty display_name", () => {
    const db = makeTestDb();
    seedAgent(db, "triage-lead", "");
    const resolved = resolveMentions(db, "@agent/triage-lead");
    expect(resolved.get("@agent/triage-lead").label).toBe("Triage Lead");
  });

  it("marks unknown tokens as deleted", () => {
    const db = makeTestDb();
    const resolved = resolveMentions(db, "@agent/missing", { dataDir: makeKbDir() });
    expect(resolved.get("@agent/missing")).toMatchObject({
      exists: false,
      label: "@agent/missing",
      href: null,
    });
  });

  it("dedupes tokens before issuing queries", () => {
    const db = makeTestDb();
    seedAgent(db, "triager", "Triager Bot");
    const resolved = resolveMentions(db, "@agent/triager and @agent/triager");
    expect(resolved.size).toBe(1);
    expect(resolved.get("@agent/triager").exists).toBe(true);
  });
});

describe("resolvedMentionsToObject", () => {
  it("converts a Map to a JSON-friendly record", () => {
    const db = makeTestDb();
    seedAgent(db, "triager", "Triager Bot");
    const obj = resolvedMentionsToObject(resolveMentions(db, "@agent/triager"));
    expect(obj["@agent/triager"].label).toBe("Triager Bot");
  });
});

describe("expandMentionsForLlm", () => {
  it("rewrites known tokens in place and preserves the rest of the text", () => {
    const db = makeTestDb();
    seedAgent(db, "triager", "Triager Bot");
    seedTask(db, { id: "task-1", task_key: "T-42", title: "Fix login" });

    const out = expandMentionsForLlm(db, "Hey @agent/triager handle @task/T-42, please.");
    expect(out).toBe(
      "Hey Triager Bot (agent, @agent/triager) handle T-42 Fix login (task, @task/T-42), please.",
    );
  });

  it("leaves unknown tokens untouched so dangling refs are visible", () => {
    const db = makeTestDb();
    expect(expandMentionsForLlm(db, "see @agent/nope")).toBe("see @agent/nope");
  });

  it("returns the input unchanged when there are no tokens", () => {
    const db = makeTestDb();
    expect(expandMentionsForLlm(db, "no tokens here")).toBe("no tokens here");
    expect(expandMentionsForLlm(db, "")).toBe("");
  });
});
