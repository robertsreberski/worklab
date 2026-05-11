import { describe, expect, it } from "vitest";
import { withMentions } from "../../api/lib/with-mentions.js";
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
