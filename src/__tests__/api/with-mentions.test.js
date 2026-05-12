import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withMentions } from "../../api/lib/with-mentions.js";
import { kbCreate } from "../../core/kb.js";
import { makeTestDb } from "../helpers/test-db.js";

function seedAgent(db, name, displayName = name) {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)
  `).run(name, displayName, now, now);
}

describe("withMentions", () => {
  it("returns an empty mentions map when sources contain no tokens", () => {
    const db = makeTestDb();
    const out = withMentions({ db }, { task: { title: "hello" } }, ["hello"]);
    expect(out).toEqual({ task: { title: "hello" }, mentions: {} });
  });

  it("collects tokens from string sources and resolves them", () => {
    const db = makeTestDb();
    seedAgent(db, "triager", "Triager Bot");
    const text = "Hey @agent/triager can you handle this?";

    const out = withMentions({ db }, { body: text }, [text]);

    expect(out.body).toBe(text);
    expect(out.mentions["@agent/triager"]).toMatchObject({
      type: "agent",
      label: "Triager Bot",
      href: "#/library/agents/triager",
      exists: true,
    });
  });

  it("collects Markdown entity links and resolves them by href key", () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-with-mentions-"));
    mkdirSync(join(dataDir, "knowledge"), { recursive: true });
    seedAgent(db, "triager", "Triager Bot");
    kbCreate({
      dataDir,
      slug: "auth-flow",
      title: "Authentication Flow",
      body: "doc",
      author: "human",
      now: new Date("2026-05-12T12:00:00Z"),
    });

    try {
      const text = "See [wrong agent](#/library/agents/triager) and [wrong note](#/library/knowledge/auth-flow).";
      const out = withMentions({ db, dataDir }, { body: text }, [text]);

      expect(out.mentions["#/library/agents/triager"]).toMatchObject({
        type: "agent",
        label: "Triager Bot",
        href: "#/library/agents/triager",
        exists: true,
      });
      expect(out.mentions["#/library/knowledge/auth-flow"]).toMatchObject({
        type: "kb",
        label: "Authentication Flow",
        href: "#/library/knowledge/auth-flow",
        exists: true,
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("walks arrays and nested objects to find tokens", () => {
    const db = makeTestDb();
    seedAgent(db, "alpha", "Alpha");
    seedAgent(db, "beta", "Beta");
    const out = withMentions(
      { db },
      { task: { title: "see @agent/alpha", comments: [{ body: "ping @agent/beta" }] } },
      [
        "see @agent/alpha",
        [{ body: "ping @agent/beta" }],
      ],
    );
    expect(Object.keys(out.mentions).sort()).toEqual(["@agent/alpha", "@agent/beta"]);
  });

  it("dedupes repeated tokens before resolving", () => {
    const db = makeTestDb();
    seedAgent(db, "triager", "Triager Bot");
    const out = withMentions(
      { db },
      { x: 1 },
      ["@agent/triager and @agent/triager again"],
    );
    expect(Object.keys(out.mentions)).toEqual(["@agent/triager"]);
  });

  it("marks dangling references as exists=false", () => {
    const db = makeTestDb();
    const out = withMentions({ db }, { x: 1 }, ["see @agent/missing"]);
    expect(out.mentions["@agent/missing"]).toMatchObject({
      exists: false,
      href: null,
    });
  });
});
