import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoPromotedRunResultInfo,
  kbEntryClassification,
  kbPath,
  kbList,
  kbRead,
  kbCreate,
  kbTaxonomy,
  kbUpdate,
  kbDelete,
  kbListPinned,
  normalizeKbCategory,
  normalizeKbTag,
} from "../../core/kb.js";

const dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
function mk() {
  const d = mkdtempSync(join(tmpdir(), "worklab-kb-"));
  dirs.push(d);
  return d;
}

describe("kbPath", () => {
  it("joins dataDir/knowledge/<slug>.md", () => {
    expect(kbPath("/data", "my-note")).toBe("/data/knowledge/my-note.md");
  });
});

describe("kbCreate + kbRead (round trip)", () => {
  it("normalizes reusable taxonomy on write", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "plan-note",
      title: "Plan Note",
      body: "body",
      tags: ["Jetpack.com", " exec-plan ", "Jetpack Com"],
      category: "execution-plan",
      subcategory: "Runtime Settings",
      author: "human",
    });

    const out = kbRead({ dataDir: d, slug: "plan-note" });
    expect(out.meta.category).toBe("plans");
    expect(out.meta.subcategory).toBe("runtime-settings");
    expect(out.meta.tags).toEqual(["jetpack-com", "execplan"]);
    expect(out.meta.meaningful_plan).toBe(true);
    expect(out.meta.surface).toBe("plans");
  });

  it("writes an entry and reads it back with flow-syntax tags", () => {
    const d = mk();
    const now = new Date("2026-04-22T10:00:00Z");
    kbCreate({
      dataDir: d,
      slug: "hello-world",
      title: "Hello",
      body: "# heading\n\nSome body",
      tags: ["alpha", "beta"],
      category: "notes",
      pinned: false,
      author: "human",
      now,
    });
    const out = kbRead({ dataDir: d, slug: "hello-world" });
    expect(out).not.toBeNull();
    expect(out.meta.title).toBe("Hello");
    expect(out.meta.slug).toBe("hello-world");
    expect(out.meta.tags).toEqual(["alpha", "beta"]);
    expect(out.meta.category).toBe("notes");
    expect(out.meta.pinned).toBe(false);
    expect(out.meta.author).toBe("human");
    expect(out.meta.created_at).toBe("2026-04-22T10:00:00Z");
    expect(out.meta.updated_at).toBe("2026-04-22T10:00:00Z");
    expect(out.body.trim()).toBe("# heading\n\nSome body");
  });

  it("round-trips project and subcategory metadata", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "project-note",
      title: "Project Note",
      body: "body",
      tags: ["alpha", "alpha", " beta "],
      category: "research",
      subcategory: "ui-audit",
      project_id: "project-1",
      author: "human",
    });

    const out = kbRead({ dataDir: d, slug: "project-note" });
    expect(out.meta.project_id).toBe("project-1");
    expect(out.meta.subcategory).toBe("ui-audit");
    expect(out.meta.tags).toEqual(["alpha", "beta"]);
  });

  it("round-trips source and relationship metadata", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "canonical-runbook",
      title: "Canonical Runbook",
      body: "body",
      tags: ["runbook"],
      category: "runbook",
      project_id: "project-1",
      source_task_id: "task-1",
      source_task_key: "T-1",
      source_run_id: "run-1",
      source_agent: "agent-one",
      related_slugs: ["first-note", "second-note", "first-note"],
      supersedes_slugs: ["old-note"],
      canonical_slug: "canonical-runbook",
      author: "human",
    });

    const out = kbRead({ dataDir: d, slug: "canonical-runbook" });
    expect(out.meta).toMatchObject({
      source_task_id: "task-1",
      source_task_key: "T-1",
      source_run_id: "run-1",
      source_agent: "agent-one",
      related_slugs: ["first-note", "second-note"],
      supersedes_slugs: ["old-note"],
      canonical_slug: "canonical-runbook",
    });
    expect(kbList({ dataDir: d })[0]).toMatchObject({
      source_task_id: "task-1",
      source_task_key: "T-1",
      source_run_id: "run-1",
      source_agent: "agent-one",
      related_slugs: ["first-note", "second-note"],
      supersedes_slugs: ["old-note"],
      canonical_slug: "canonical-runbook",
    });
  });

  it("parses block-form (indented) tag lists on read", () => {
    const d = mk();
    mkdirSync(join(d, "knowledge"), { recursive: true });
    // Hand-craft a file with block-form YAML tags
    const content = `---
title: Block Tags
slug: block-tags
tags:
  - one
  - two
  - three
category: docs
pinned: true
author: human
created_at: 2026-04-21T10:00:00Z
updated_at: 2026-04-21T10:00:00Z
---

Body here.
`;
    writeFileSync(join(d, "knowledge", "block-tags.md"), content);
    const out = kbRead({ dataDir: d, slug: "block-tags" });
    expect(out.meta.tags).toEqual(["one", "two", "three"]);
    expect(out.meta.pinned).toBe(true);
    expect(out.meta.category).toBe("docs");
  });

  it("kbRead returns null for missing file", () => {
    const d = mk();
    expect(kbRead({ dataDir: d, slug: "nope" })).toBeNull();
  });

  it("rejects creating a slug that already exists", () => {
    const d = mk();
    kbCreate({ dataDir: d, slug: "dupe", title: "A", body: "x", author: "human" });
    expect(() =>
      kbCreate({ dataDir: d, slug: "dupe", title: "B", body: "y", author: "human" }),
    ).toThrow(/exist/i);
  });

  it("auto-creates the knowledge directory on first write", () => {
    const d = mk();
    expect(existsSync(join(d, "knowledge"))).toBe(false);
    kbCreate({ dataDir: d, slug: "fresh", title: "T", body: "b", author: "human" });
    expect(existsSync(join(d, "knowledge"))).toBe(true);
    expect(existsSync(join(d, "knowledge", "fresh.md"))).toBe(true);
  });

  it("writes frontmatter in stable key order", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "ordered",
      title: "T",
      body: "b",
      tags: ["x"],
      category: "c",
      pinned: true,
      author: "human",
      now: new Date("2026-04-22T00:00:00Z"),
    });
    const raw = readFileSync(join(d, "knowledge", "ordered.md"), "utf8");
    const lines = raw.split("\n");
    const order = [];
    for (const line of lines) {
      if (line === "---") continue;
      if (line.startsWith("#") || line.trim() === "") break;
      const k = line.split(":")[0].trim();
      if (k && !k.startsWith("-")) order.push(k);
    }
    expect(order).toEqual([
      "title",
      "slug",
      "tags",
      "category",
      "pinned",
      "author",
      "created_at",
      "updated_at",
    ]);
  });

  it("omits category key when null", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "nocat",
      title: "T",
      body: "b",
      author: "human",
    });
    const raw = readFileSync(join(d, "knowledge", "nocat.md"), "utf8");
    expect(raw).not.toMatch(/^category:/m);
    const out = kbRead({ dataDir: d, slug: "nocat" });
    expect(out.meta.category).toBeNull();
  });
});

describe("kbUpdate", () => {
  it("merges frontmatter patch and preserves untouched keys", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "u1",
      title: "Orig",
      body: "b",
      tags: ["a"],
      category: "cat1",
      pinned: false,
      author: "human",
      now: new Date("2026-04-21T10:00:00Z"),
    });
    kbUpdate({
      dataDir: d,
      slug: "u1",
      patch: { title: "New Title", pinned: true },
      now: new Date("2026-04-22T11:00:00Z"),
    });
    const out = kbRead({ dataDir: d, slug: "u1" });
    expect(out.meta.title).toBe("New Title");
    expect(out.meta.pinned).toBe(true);
    expect(out.meta.tags).toEqual(["a"]); // untouched
    expect(out.meta.category).toBe("cat1"); // untouched
    expect(out.meta.created_at).toBe("2026-04-21T10:00:00Z"); // untouched
    expect(out.meta.updated_at).toBe("2026-04-22T11:00:00Z"); // bumped
  });

  it("patch.body replaces body", () => {
    const d = mk();
    kbCreate({ dataDir: d, slug: "b1", title: "T", body: "old body", author: "human" });
    kbUpdate({ dataDir: d, slug: "b1", patch: { body: "brand new body" } });
    const out = kbRead({ dataDir: d, slug: "b1" });
    expect(out.body.trim()).toBe("brand new body");
  });

  it("patch with both frontmatter and body replaces both", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "both",
      title: "T",
      body: "old",
      tags: [],
      author: "human",
    });
    kbUpdate({
      dataDir: d,
      slug: "both",
      patch: { title: "Newer", body: "newer body" },
    });
    const out = kbRead({ dataDir: d, slug: "both" });
    expect(out.meta.title).toBe("Newer");
    expect(out.body.trim()).toBe("newer body");
  });

  it("throws on non-existent slug", () => {
    const d = mk();
    expect(() => kbUpdate({ dataDir: d, slug: "ghost", patch: { title: "x" } })).toThrow(
      /not.?found/i,
    );
  });

  it("always bumps updated_at even when patch is empty", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "bump",
      title: "T",
      body: "b",
      author: "human",
      now: new Date("2026-04-21T10:00:00Z"),
    });
    kbUpdate({
      dataDir: d,
      slug: "bump",
      patch: {},
      now: new Date("2026-04-22T11:00:00Z"),
    });
    const out = kbRead({ dataDir: d, slug: "bump" });
    expect(out.meta.updated_at).toBe("2026-04-22T11:00:00Z");
    expect(out.meta.created_at).toBe("2026-04-21T10:00:00Z");
  });
});

describe("kbDelete", () => {
  it("returns true when file existed and is removed", () => {
    const d = mk();
    kbCreate({ dataDir: d, slug: "del1", title: "T", body: "b", author: "human" });
    expect(kbDelete({ dataDir: d, slug: "del1" })).toBe(true);
    expect(existsSync(join(d, "knowledge", "del1.md"))).toBe(false);
  });

  it("returns false when file did not exist", () => {
    const d = mk();
    expect(kbDelete({ dataDir: d, slug: "ghost" })).toBe(false);
  });
});

describe("kbList", () => {
  function seed(d) {
    kbCreate({
      dataDir: d,
      slug: "one",
      title: "One",
      body: "b",
      tags: ["alpha", "beta"],
      category: "notes",
      pinned: false,
      author: "human",
      now: new Date("2026-04-20T10:00:00Z"),
    });
    kbCreate({
      dataDir: d,
      slug: "two",
      title: "Two",
      body: "b",
      tags: ["alpha"],
      category: "projects",
      pinned: true,
      author: "human",
      now: new Date("2026-04-21T10:00:00Z"),
    });
    kbCreate({
      dataDir: d,
      slug: "three",
      title: "Three",
      body: "b",
      tags: ["gamma"],
      category: "notes",
      pinned: false,
      author: "agent",
      now: new Date("2026-04-22T10:00:00Z"),
    });
  }

  it("returns all entries with metadata and no body key", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d });
    expect(list.length).toBe(3);
    for (const entry of list) {
      expect(entry).not.toHaveProperty("body");
      expect(entry.slug).toBeDefined();
      expect(entry.title).toBeDefined();
      expect(Array.isArray(entry.tags)).toBe(true);
    }
  });

  it("filters with normalized tag and category aliases", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "runtime-plan",
      title: "Runtime Plan",
      body: "b",
      tags: ["jetpack.com"],
      category: "exec-plan",
      author: "human",
    });
    kbCreate({
      dataDir: d,
      slug: "runtime-report",
      title: "Runtime Report",
      body: "b",
      tags: ["jetpack.com"],
      category: "research",
      author: "human",
    });

    expect(kbList({ dataDir: d, tag: "jetpack.com" }).map((entry) => entry.slug).sort()).toEqual([
      "runtime-plan",
      "runtime-report",
    ]);
    expect(kbList({ dataDir: d, category: "execution-plan" }).map((entry) => entry.slug)).toEqual([
      "runtime-plan",
    ]);
  });

  it("does NOT load body content (verified via large body)", () => {
    const d = mk();
    const big = "x".repeat(500_000);
    kbCreate({ dataDir: d, slug: "big", title: "Big", body: big, author: "human" });
    const list = kbList({ dataDir: d });
    expect(list.length).toBe(1);
    expect(list[0]).not.toHaveProperty("body");
    expect(JSON.stringify(list[0]).length).toBeLessThan(1000);
  });

  it("defaults to sorting by updated_at DESC without pin promotion", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d });
    expect(list.map((x) => x.slug)).toEqual(["three", "two", "one"]);
  });

  it("supports explicit pinned-first sorting", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d, sort: "pinned_first" });
    expect(list.map((x) => x.slug)).toEqual(["two", "three", "one"]);
  });

  it("supports title A-Z sorting", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d, sort: "title_asc" });
    expect(list.map((x) => x.slug)).toEqual(["one", "three", "two"]);
  });

  it("supports project/category sorting with global entries last", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "global-note",
      title: "Global",
      body: "b",
      category: "decision",
      author: "human",
      now: new Date("2026-05-06T00:00:00Z"),
    });
    kbCreate({
      dataDir: d,
      slug: "project-runbook",
      title: "Runbook",
      body: "b",
      category: "runbook",
      project_id: "project-1",
      author: "human",
      now: new Date("2026-05-05T00:00:00Z"),
    });
    kbCreate({
      dataDir: d,
      slug: "project-research",
      title: "Research",
      body: "b",
      category: "research",
      project_id: "project-1",
      pinned: true,
      author: "human",
      now: new Date("2026-05-04T00:00:00Z"),
    });
    kbCreate({
      dataDir: d,
      slug: "other-project",
      title: "Other Project",
      body: "b",
      category: "decision",
      project_id: "project-2",
      author: "human",
      now: new Date("2026-05-07T00:00:00Z"),
    });

    const list = kbList({ dataDir: d, sort: "project_category" });
    expect(list.map((x) => x.slug)).toEqual([
      "project-research",
      "project-runbook",
      "other-project",
      "global-note",
    ]);
  });

  it("filters by tag", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d, tag: "alpha" });
    expect(list.map((x) => x.slug).sort()).toEqual(["one", "two"]);
  });

  it("filters by category", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d, category: "notes" });
    expect(list.map((x) => x.slug).sort()).toEqual(["one", "three"]);
  });

  it("filters by pinned=true", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d, pinned: true });
    expect(list.map((x) => x.slug)).toEqual(["two"]);
  });

  it("filters by pinned=false", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d, pinned: false });
    expect(list.map((x) => x.slug).sort()).toEqual(["one", "three"]);
  });

  it("combines filters (tag + category)", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d, tag: "alpha", category: "notes" });
    expect(list.map((x) => x.slug)).toEqual(["one"]);
  });

  it("combines filters (tag + pinned)", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d, tag: "alpha", pinned: true });
    expect(list.map((x) => x.slug)).toEqual(["two"]);
  });

  it("combines all three filters", () => {
    const d = mk();
    seed(d);
    const list = kbList({ dataDir: d, tag: "alpha", category: "projects", pinned: true });
    expect(list.map((x) => x.slug)).toEqual(["two"]);
  });

  it("filters by project and subcategory", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "one",
      title: "One",
      body: "",
      category: "research",
      subcategory: "ui-audit",
      project_id: "project-1",
      author: "human",
    });
    kbCreate({
      dataDir: d,
      slug: "two",
      title: "Two",
      body: "",
      category: "research",
      subcategory: "runtime",
      project_id: "project-1",
      author: "human",
    });
    kbCreate({
      dataDir: d,
      slug: "three",
      title: "Three",
      body: "",
      category: "research",
      subcategory: "ui-audit",
      project_id: "project-2",
      author: "human",
    });

    const list = kbList({ dataDir: d, project_id: "project-1", subcategory: "ui-audit" });
    expect(list.map((x) => x.slug)).toEqual(["one"]);
  });

  it("returns [] when knowledge dir does not exist", () => {
    const d = mk();
    expect(kbList({ dataDir: d })).toEqual([]);
  });

  it("coerces missing category to null in list output", () => {
    const d = mk();
    kbCreate({ dataDir: d, slug: "nc", title: "T", body: "b", author: "human" });
    const list = kbList({ dataDir: d });
    expect(list[0].category).toBeNull();
  });
});

describe("autoPromotedRunResultInfo", () => {
  it("detects generated fallback run-result entries and extracts source refs", () => {
    const entry = {
      meta: {
        slug: "run-abc123",
        title: "T-1 final answer from coder",
        category: "run-results",
        tags: ["run-result", "execute", "agent-coder"],
        pinned: false,
      },
      body: [
        "Source task: [T-1 - Build thing](#/tasks/T-1)",
        "Source run: [RunABC](/api/runs/RunABC/raw-log)",
        "Stage: execute",
        "Agent: coder",
        "",
        "---",
        "",
        "Long final answer.",
      ].join("\n"),
    };

    expect(autoPromotedRunResultInfo(entry)).toMatchObject({
      auto_promoted: true,
      source_run_id: "RunABC",
      source_task_ref: "T-1",
      source_agent: "coder",
    });
  });

  it("does not classify deliberate run-results as auto-promoted assets", () => {
    const entry = {
      meta: {
        slug: "triforce-daily-2026-05-05",
        title: "Triforce daily catch-up",
        category: "run-results",
        tags: ["triforce", "daily-catchup"],
      },
      body: "# Triforce daily catch-up\n\nReusable digest.",
    };

    expect(autoPromotedRunResultInfo(entry).auto_promoted).toBe(false);
  });

  it("detects generated run-result entries from frontmatter metadata", () => {
    const entry = {
      meta: {
        slug: "run-def456",
        title: "T-2 final answer from coder",
        category: "run-results",
        tags: ["run-result", "execute", "agent-coder"],
        source_run_id: "RunDEF",
        source_task_key: "T-2",
        source_agent: "coder",
        pinned: false,
      },
      body: "",
    };

    expect(autoPromotedRunResultInfo(entry)).toMatchObject({
      auto_promoted: true,
      source_run_id: "RunDEF",
      source_task_ref: "T-2",
      source_agent: "coder",
    });
  });
});

describe("KB taxonomy helpers", () => {
  it("normalizes category and tag aliases", () => {
    expect(normalizeKbCategory("Exec Plan")).toBe("plans");
    expect(normalizeKbCategory("execution-plan")).toBe("plans");
    expect(normalizeKbCategory("run result")).toBe("run-results");
    expect(normalizeKbTag("Jetpack.com")).toBe("jetpack-com");
    expect(normalizeKbTag("run-results")).toBe("run-result");
  });

  it("classifies plans separately from generated run outputs", () => {
    expect(kbEntryClassification({
      slug: "path-forward-execplan",
      title: "Path Forward ExecPlan",
      category: "plans",
      tags: ["execplan"],
    })).toMatchObject({
      surface: "plans",
      meaningful_plan: true,
      run_output: false,
    });

    expect(kbEntryClassification({
      slug: "run-abc",
      title: "T-1 final answer",
      category: "run-results",
      tags: ["run-result", "execute"],
      source_run_id: "abc",
    })).toMatchObject({
      surface: "run_outputs",
      meaningful_plan: false,
      run_output: true,
    });
  });

  it("returns taxonomy counts and raw alias cleanup candidates", () => {
    const d = mk();
    mkdirSync(join(d, "knowledge"), { recursive: true });
    writeFileSync(join(d, "knowledge", "old-plan.md"), `---
title: Old Plan
slug: old-plan
tags: [Jetpack.com, exec-plan]
category: execution-plan
updated_at: 2026-05-01T00:00:00Z
---

body
`);
    kbCreate({
      dataDir: d,
      slug: "research-note",
      title: "Research",
      body: "body",
      tags: ["jetpack-com"],
      category: "research",
      author: "human",
    });

    const taxonomy = kbTaxonomy({ dataDir: d });
    expect(taxonomy.categories).toContainEqual({ category: "plans", count: 1 });
    expect(taxonomy.tags).toContainEqual({ tag: "jetpack-com", count: 2 });
    expect(taxonomy.aliases.categories).toContainEqual({
      raw: "execution-plan",
      normalized: "plans",
      count: 1,
    });
    expect(taxonomy.aliases.tags).toContainEqual({
      raw: "Jetpack.com",
      normalized: "jetpack-com",
      count: 1,
    });
  });
});

describe("slug validation", () => {
  const bad = [
    ["uppercase", "My-Note"],
    ["underscore", "my_note"],
    ["leading dash", "-note"],
    ["trailing dash", "note-"],
    ["double dash", "my--note"],
    ["empty string", ""],
    ["unicode", "naïve"],
    ["space", "my note"],
    ["dot", "my.note"],
    ["slash", "my/note"],
  ];
  it.each(bad)("rejects %s: %s", (_label, slug) => {
    const d = mk();
    expect(() =>
      kbCreate({ dataDir: d, slug, title: "T", body: "b", author: "human" }),
    ).toThrow(/invalid slug/i);
  });

  it("accepts valid slugs", () => {
    const d = mk();
    for (const slug of ["a", "abc", "my-note", "note-1", "a1b2-c3"]) {
      kbCreate({ dataDir: d, slug, title: "T", body: "b", author: "human" });
    }
  });

  it("kbRead rejects invalid slug (defensive)", () => {
    const d = mk();
    expect(() => kbRead({ dataDir: d, slug: "Bad_Slug" })).toThrow(/invalid slug/i);
  });

  it("kbUpdate rejects invalid slug (defensive)", () => {
    const d = mk();
    expect(() => kbUpdate({ dataDir: d, slug: "Bad_Slug", patch: {} })).toThrow(
      /invalid slug/i,
    );
  });

  it("kbDelete rejects invalid slug (defensive)", () => {
    const d = mk();
    expect(() => kbDelete({ dataDir: d, slug: "Bad_Slug" })).toThrow(/invalid slug/i);
  });
});

describe("string coercion round-trip (quoted strings)", () => {
  it("round-trips title that looks like a boolean (\"true\")", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "str-true",
      title: "true",
      body: "b",
      author: "human",
    });
    const out = kbRead({ dataDir: d, slug: "str-true" });
    expect(typeof out.meta.title).toBe("string");
    expect(out.meta.title).toBe("true");
  });

  it("round-trips title that looks like a number (\"42\")", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "str-42",
      title: "42",
      body: "b",
      author: "human",
    });
    const out = kbRead({ dataDir: d, slug: "str-42" });
    expect(typeof out.meta.title).toBe("string");
    expect(out.meta.title).toBe("42");
  });

  it("round-trips title that looks like a flow array (\"[note]\")", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "str-flow",
      title: "[note]",
      body: "b",
      author: "human",
    });
    const out = kbRead({ dataDir: d, slug: "str-flow" });
    expect(typeof out.meta.title).toBe("string");
    expect(out.meta.title).toBe("[note]");
  });

  it("round-trips title with ambiguous colon (\"My: sequel\")", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "str-colon",
      title: "My: sequel",
      body: "b",
      author: "human",
    });
    const out = kbRead({ dataDir: d, slug: "str-colon" });
    expect(out.meta.title).toBe("My: sequel");
  });

  it("round-trips title that is null sentinel (\"null\")", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "str-null",
      title: "null",
      body: "b",
      author: "human",
    });
    const out = kbRead({ dataDir: d, slug: "str-null" });
    expect(typeof out.meta.title).toBe("string");
    expect(out.meta.title).toBe("null");
  });

  it("round-trips empty-string title", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "str-empty",
      title: "",
      body: "b",
      author: "human",
    });
    const out = kbRead({ dataDir: d, slug: "str-empty" });
    expect(typeof out.meta.title).toBe("string");
    expect(out.meta.title).toBe("");
  });

  it("escapes backslash and double quotes inside strings", () => {
    const d = mk();
    const evil = 'she said "hi" and \\ then left';
    kbCreate({
      dataDir: d,
      slug: "str-escape",
      title: evil,
      body: "b",
      author: "human",
    });
    const out = kbRead({ dataDir: d, slug: "str-escape" });
    expect(out.meta.title).toBe(evil);
  });

  it("normalizes tags array with coercible strings [\"true\", \"42\", \"a:b\"]", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "tags-coerce",
      title: "T",
      body: "b",
      tags: ["true", "42", "a:b"],
      author: "human",
    });
    const out = kbRead({ dataDir: d, slug: "tags-coerce" });
    expect(Array.isArray(out.meta.tags)).toBe(true);
    expect(out.meta.tags).toEqual(["true", "42", "a-b"]);
    for (const t of out.meta.tags) expect(typeof t).toBe("string");
  });

  it("does not add redundant quotes for plain strings", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "plain",
      title: "Just a title",
      body: "b",
      author: "human",
    });
    const raw = readFileSync(join(d, "knowledge", "plain.md"), "utf8");
    expect(raw).toMatch(/^title: Just a title$/m);
  });

  it("block-form tags parser strips double quotes on coercion-trigger items", () => {
    const d = mk();
    mkdirSync(join(d, "knowledge"), { recursive: true });
    const content = `---
title: Block Q
slug: block-q
tags:
  - "true"
  - "42"
  - plain
---

Body.
`;
    writeFileSync(join(d, "knowledge", "block-q.md"), content);
    const out = kbRead({ dataDir: d, slug: "block-q" });
    expect(out.meta.tags).toEqual(["true", "42", "plain"]);
    for (const t of out.meta.tags) expect(typeof t).toBe("string");
  });

  it("normalizes flow-array tags containing commas", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "comma-tags",
      title: "T",
      body: "b",
      tags: ["a, b", "c:d", "normal"],
      author: "human",
    });
    const out = kbRead({ dataDir: d, slug: "comma-tags" });
    expect(out.meta.tags).toEqual(["a-b", "c-d", "normal"]);
    expect(out.meta.tags.length).toBe(3);
    expect(out.meta.tags[0]).toBe("a-b");
  });

  it("round-trips standalone string value with comma", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "comma-title",
      title: "Intro, Chapter 1",
      body: "b",
      author: "human",
    });
    const out = kbRead({ dataDir: d, slug: "comma-title" });
    expect(out.meta.title).toBe("Intro, Chapter 1");
  });
});

describe("kbList — malformed frontmatter tolerance", () => {
  it("skips a file with broken frontmatter and warns on stderr", () => {
    const d = mk();
    kbCreate({ dataDir: d, slug: "good", title: "Good", body: "b", author: "human" });
    // Craft a broken file: opening `---` but no closing delimiter.
    const broken = `---
title: Broken
slug: broken
this file never closes its frontmatter
`;
    writeFileSync(join(d, "knowledge", "broken.md"), broken);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let list;
    expect(() => {
      list = kbList({ dataDir: d });
    }).not.toThrow();

    // The valid entry is returned; the malformed one is omitted.
    expect(list.map((x) => x.slug)).toEqual(["good"]);
    // A warning was emitted for the broken entry.
    const call = warnSpy.mock.calls.find((c) => c[0] === "[kb] skipping unreadable entry");
    expect(call).toBeDefined();
    expect(call[1]).toMatchObject({
      file: expect.stringContaining("broken.md"),
      err: expect.any(String),
    });
    warnSpy.mockRestore();
  });

  it("does NOT misread a mid-body `---` as the frontmatter terminator", () => {
    const d = mk();
    mkdirSync(join(d, "knowledge"), { recursive: true });
    const content = `---
title: real
slug: real
tags: [x]
category: notes
pinned: false
author: human
created_at: 2026-04-22T10:00:00Z
updated_at: 2026-04-22T10:00:00Z
---

Intro paragraph.
---
This is a section after a horizontal rule.
`;
    writeFileSync(join(d, "knowledge", "real.md"), content);
    const list = kbList({ dataDir: d });
    expect(list.length).toBe(1);
    const entry = list[0];
    expect(entry.slug).toBe("real");
    expect(entry.title).toBe("real");
    expect(entry.tags).toEqual(["x"]);
    expect(entry.category).toBe("notes");
    expect(entry.author).toBe("human");
  });

  it("readFrontmatterOnly rejects loose `\\n---foo` mid-body match", () => {
    const d = mk();
    mkdirSync(join(d, "knowledge"), { recursive: true });
    // Body contains `\n---important` which is NOT a valid terminator
    // (no newline or EOF after the three dashes).
    const content = `---
title: tight
slug: tight
tags: []
author: human
---

Some body.
---important notice
---
`;
    writeFileSync(join(d, "knowledge", "tight.md"), content);
    const list = kbList({ dataDir: d });
    // Frontmatter should parse only the block bounded by the first `---` and
    // the first line that is exactly `---`.
    expect(list.length).toBe(1);
    expect(list[0].title).toBe("tight");
    expect(list[0].slug).toBe("tight");
  });
});

describe("writeAtomic durability", () => {
  it("produces a readable file after kbCreate (no .tmp leftover)", () => {
    const d = mk();
    kbCreate({ dataDir: d, slug: "dura", title: "T", body: "b", author: "human" });
    const finalPath = join(d, "knowledge", "dura.md");
    expect(existsSync(finalPath)).toBe(true);
    expect(existsSync(`${finalPath}.tmp`)).toBe(false);
    // File is fully written and terminates with a newline.
    const raw = readFileSync(finalPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});

describe("kbListPinned", () => {
  function seedMixed(d) {
    kbCreate({
      dataDir: d,
      slug: "pinned-a",
      title: "Pinned A",
      body: "body of pinned-a",
      pinned: true,
      author: "human",
      now: new Date("2026-04-22T12:00:00Z"),
    });
    kbCreate({
      dataDir: d,
      slug: "pinned-b",
      title: "Pinned B",
      body: "body of pinned-b",
      pinned: true,
      author: "human",
      now: new Date("2026-04-21T12:00:00Z"),
    });
    kbCreate({
      dataDir: d,
      slug: "not-pinned",
      title: "Not Pinned",
      body: "body of not-pinned",
      pinned: false,
      author: "human",
      now: new Date("2026-04-23T12:00:00Z"),
    });
  }

  it("returns empty array when no KB exists (missing knowledge dir)", () => {
    const d = mk();
    expect(kbListPinned({ dataDir: d })).toEqual([]);
  });

  it("returns only pinned entries", () => {
    const d = mk();
    seedMixed(d);
    const result = kbListPinned({ dataDir: d });
    expect(result.every((e) => e.pinned === true)).toBe(true);
    const slugs = result.map((e) => e.slug).sort();
    expect(slugs).toEqual(["pinned-a", "pinned-b"]);
  });

  it("returns bodies (not just meta)", () => {
    const d = mk();
    seedMixed(d);
    const result = kbListPinned({ dataDir: d });
    for (const entry of result) {
      expect(entry).toHaveProperty("body");
      expect(typeof entry.body).toBe("string");
      expect(entry.body.trim().length).toBeGreaterThan(0);
    }
    const a = result.find((e) => e.slug === "pinned-a");
    expect(a.body.trim()).toBe("body of pinned-a");
  });

  it("orders by updated_at DESC within pinned entries", () => {
    const d = mk();
    seedMixed(d);
    const result = kbListPinned({ dataDir: d });
    // pinned-a updated 2026-04-22, pinned-b updated 2026-04-21 → a first
    expect(result.map((e) => e.slug)).toEqual(["pinned-a", "pinned-b"]);
  });

  it("respects the limit parameter", () => {
    const d = mk();
    for (let i = 1; i <= 5; i++) {
      kbCreate({
        dataDir: d,
        slug: `entry-${i}`,
        title: `Entry ${i}`,
        body: `body ${i}`,
        pinned: true,
        author: "human",
        now: new Date(`2026-04-${10 + i}T10:00:00Z`),
      });
    }
    const result = kbListPinned({ dataDir: d, limit: 3 });
    expect(result.length).toBe(3);
  });

  it("default limit is 10", () => {
    const d = mk();
    for (let i = 1; i <= 15; i++) {
      kbCreate({
        dataDir: d,
        slug: `bulk-${i}`,
        title: `Bulk ${i}`,
        body: `body ${i}`,
        pinned: true,
        author: "human",
        now: new Date(`2026-04-${String(i).padStart(2, "0")}T10:00:00Z`),
      });
    }
    const result = kbListPinned({ dataDir: d });
    expect(result.length).toBe(10);
  });

  it("ignores non-pinned entries even when list is otherwise short", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "unpinned-only",
      title: "Unpinned",
      body: "body",
      pinned: false,
      author: "human",
    });
    const result = kbListPinned({ dataDir: d });
    expect(result).toEqual([]);
  });

  it("handles missing knowledge dir gracefully (returns [])", () => {
    const d = mk();
    // No knowledge dir created, no files written
    const result = kbListPinned({ dataDir: "/nonexistent/path/that/does/not/exist" });
    expect(result).toEqual([]);
  });

  it("includes full entry shape (slug, title, body, category, tags, pinned, author, created_at, updated_at)", () => {
    const d = mk();
    kbCreate({
      dataDir: d,
      slug: "full-entry",
      title: "Full Entry",
      body: "full body text",
      pinned: true,
      tags: ["x", "y"],
      category: "docs",
      author: "human",
      now: new Date("2026-04-22T10:00:00Z"),
    });
    const result = kbListPinned({ dataDir: d });
    expect(result.length).toBe(1);
    const entry = result[0];
    expect(entry.slug).toBe("full-entry");
    expect(entry.title).toBe("Full Entry");
    expect(entry.body.trim()).toBe("full body text");
    expect(entry.category).toBe("docs");
    expect(entry.tags).toEqual(["x", "y"]);
    expect(entry.pinned).toBe(true);
    expect(entry.author).toBe("human");
    expect(entry.created_at).toBe("2026-04-22T10:00:00Z");
    expect(entry.updated_at).toBe("2026-04-22T10:00:00Z");
  });
});
