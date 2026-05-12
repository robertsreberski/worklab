import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kbCreate } from "../../core/kb.js";
import { createToolHandlers, toolDefinitions } from "../../mcp/agent/tools/index.js";

describe("worklab-tools KB handlers", () => {
  const dirs = [];
  const oldOllamaBase = process.env.WORKLAB_OLLAMA_BASE_URL;

  beforeEach(() => {
    process.env.WORKLAB_OLLAMA_BASE_URL = "http://127.0.0.1:9";
  });

  afterEach(() => {
    if (oldOllamaBase === undefined) delete process.env.WORKLAB_OLLAMA_BASE_URL;
    else process.env.WORKLAB_OLLAMA_BASE_URL = oldOllamaBase;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function ctx(agent = "alice", patch = {}) {
    const d = mkdtempSync(join(tmpdir(), "worklab-tools-kb-"));
    dirs.push(d);
    return { dataDir: d, agent, runId: "r1", taskId: "t1", taskTitle: "demo", ...patch };
  }

  // ── kb_create ────────────────────────────────────────────────────────────

  it("kb_create happy path — entry readable via kb_read with author=context.agent", async () => {
    const c = ctx("alice");
    const h = createToolHandlers(c);
    const r = await h.kb_create({ slug: "my-note", title: "My Note", body: "hello" });
    expect(r).toEqual({ ok: true, slug: "my-note" });

    const read = await h.kb_read({ slug: "my-note" });
    expect(read.meta.slug).toBe("my-note");
    expect(read.meta.title).toBe("My Note");
    expect(read.body).toContain("hello");
    // author must come from context.agent, not caller input
    expect(read.meta.author).toBe("alice");
  });

  it("kb_create stores tags and category", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({
      slug: "tagged",
      title: "Tagged",
      body: "body",
      tags: ["a", "b"],
      category: "ops",
      pinned: true,
    });
    const read = await h.kb_read({ slug: "tagged" });
    expect(read.meta.tags).toEqual(["a", "b"]);
    expect(read.meta.category).toBe("ops");
    expect(read.meta.pinned).toBe(true);
  });

  it("kb_create inherits project id from run context and stores subcategory", async () => {
    const c = ctx("alice", { projectId: "project-1" });
    const h = createToolHandlers(c);
    await h.kb_create({
      slug: "project-note",
      title: "Project Note",
      body: "body",
      category: "research",
      subcategory: "ui-audit",
    });
    const read = await h.kb_read({ slug: "project-note" });
    expect(read.meta.project_id).toBe("project-1");
    expect(read.meta.subcategory).toBe("ui-audit");
  });

  it("kb_create stores source and relationship metadata", async () => {
    const c = ctx("alice", { projectId: "project-1" });
    const h = createToolHandlers(c);
    await h.kb_create({
      slug: "linked-note",
      title: "Linked Note",
      body: "body",
      source_task_id: "task-1",
      source_task_key: "T-1",
      source_run_id: "run-1",
      source_agent: "alice",
      related_slugs: ["runbook", "decision"],
      supersedes_slugs: ["old-note"],
      canonical_slug: "linked-note",
    });
    const read = await h.kb_read({ slug: "linked-note" });
    expect(read.meta).toMatchObject({
      project_id: "project-1",
      source_task_id: "task-1",
      source_task_key: "T-1",
      source_run_id: "run-1",
      source_agent: "alice",
      related_slugs: ["runbook", "decision"],
      supersedes_slugs: ["old-note"],
      canonical_slug: "linked-note",
    });
  });

  it("kb_create rejects invalid slug", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await expect(h.kb_create({ slug: "Bad_Slug!", title: "X", body: "y" })).rejects.toThrow();
  });

  it("kb_create rejects duplicate slug", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "dup", title: "Dup", body: "first" });
    await expect(h.kb_create({ slug: "dup", title: "Dup2", body: "second" })).rejects.toThrow();
  });

  it("kb_create does NOT allow caller to set author", async () => {
    const c = ctx("bob");
    const h = createToolHandlers(c);
    // Even if caller passes author it must be ignored
    await h.kb_create({ slug: "sneak", title: "T", body: "b", author: "hacker" });
    const read = await h.kb_read({ slug: "sneak" });
    expect(read.meta.author).toBe("bob");
  });

  // ── kb_update ────────────────────────────────────────────────────────────

  it("kb_update happy path — body replaced", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "upd", title: "Upd", body: "original" });
    const r = await h.kb_update({ slug: "upd", patch: { body: "updated" } });
    expect(r).toEqual({ ok: true });
    const read = await h.kb_read({ slug: "upd" });
    expect(read.body).toContain("updated");
  });

  it("kb_update can update title and tags", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "meta-upd", title: "Old", body: "b" });
    await h.kb_update({ slug: "meta-upd", patch: { title: "New", tags: ["x"] } });
    const read = await h.kb_read({ slug: "meta-upd" });
    expect(read.meta.title).toBe("New");
    expect(read.meta.tags).toEqual(["x"]);
  });

  it("kb_update rejects unknown patch key 'author'", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "patch-author", title: "T", body: "b" });
    await expect(
      h.kb_update({ slug: "patch-author", patch: { author: "hacker" } })
    ).rejects.toThrow(/author/);
  });

  it("kb_update rejects unknown patch key 'created_at'", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "patch-ts", title: "T", body: "b" });
    await expect(
      h.kb_update({ slug: "patch-ts", patch: { created_at: "2000-01-01T00:00:00Z" } })
    ).rejects.toThrow(/created_at/);
  });

  it("kb_update rejects completely unknown patch key", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "patch-unknown", title: "T", body: "b" });
    await expect(
      h.kb_update({ slug: "patch-unknown", patch: { foo_bar: "baz" } })
    ).rejects.toThrow(/foo_bar/);
  });

  it("kb_update rejects non-existent slug — not_found", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await expect(
      h.kb_update({ slug: "ghost", patch: { body: "x" } })
    ).rejects.toThrow(/not_found/);
  });

  // ── kb_delete ────────────────────────────────────────────────────────────

  it("kb_delete happy path — entry gone after delete", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "to-del", title: "Del", body: "bye" });
    const r = await h.kb_delete({ slug: "to-del" });
    expect(r).toEqual({ ok: true });
    // should now be not_found
    await expect(h.kb_read({ slug: "to-del" })).rejects.toThrow(/not_found/);
  });

  it("kb_delete on missing slug throws not_found", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await expect(h.kb_delete({ slug: "missing" })).rejects.toThrow(/not_found/);
  });

  // ── kb_read ──────────────────────────────────────────────────────────────

  it("kb_read returns meta and body", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "readable", title: "Readable", body: "content here" });
    const r = await h.kb_read({ slug: "readable" });
    expect(r).toHaveProperty("meta");
    expect(r).toHaveProperty("body");
    expect(r.meta.title).toBe("Readable");
    expect(r.body).toContain("content here");
  });

  it("kb_read on missing slug throws not_found", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await expect(h.kb_read({ slug: "no-such-entry" })).rejects.toThrow(/not_found/);
  });

  // ── kb_list ──────────────────────────────────────────────────────────────

  it("kb_list returns entries", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "entry-a", title: "A", body: "a" });
    await h.kb_create({ slug: "entry-b", title: "B", body: "b" });
    const r = await h.kb_list({});
    expect(r).toHaveProperty("entries");
    expect(r.entries.length).toBe(2);
    const slugs = r.entries.map((e) => e.slug);
    expect(slugs).toContain("entry-a");
    expect(slugs).toContain("entry-b");
  });

  it("kb_list filters by tag", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "tagged-a", title: "A", body: "a", tags: ["foo"] });
    await h.kb_create({ slug: "tagged-b", title: "B", body: "b", tags: ["bar"] });
    const r = await h.kb_list({ tag: "foo" });
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].slug).toBe("tagged-a");
  });

  it("kb_list filters by category", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "cat-a", title: "A", body: "a", category: "ops" });
    await h.kb_create({ slug: "cat-b", title: "B", body: "b", category: "dev" });
    const r = await h.kb_list({ category: "ops" });
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].slug).toBe("cat-a");
  });

  it("kb_list filters by pinned=true", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({ slug: "pinned-one", title: "P", body: "p", pinned: true });
    await h.kb_create({ slug: "not-pinned", title: "N", body: "n" });
    const r = await h.kb_list({ pinned: true });
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].slug).toBe("pinned-one");
  });

  it("kb_list accepts sort modes", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    kbCreate({
      dataDir: c.dataDir,
      slug: "zebra",
      title: "Zebra",
      body: "z",
      author: "alice",
      now: new Date("2026-05-02T00:00:00Z"),
    });
    kbCreate({
      dataDir: c.dataDir,
      slug: "alpha",
      title: "Alpha",
      body: "a",
      author: "alice",
      now: new Date("2026-05-01T00:00:00Z"),
    });

    const r = await h.kb_list({ sort: "title_asc" });
    expect(r.entries.map((entry) => entry.slug)).toEqual(["alpha", "zebra"]);
  });

  it("kb_list with no entries returns empty array", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    const r = await h.kb_list({});
    expect(r.entries).toEqual([]);
  });

  // ── kb_search ────────────────────────────────────────────────────────────

  it("kb_search returns indexed content snippets", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({
      slug: "release-freeze",
      title: "Release Freeze",
      body: "During release freeze, only ship incident rollback fixes.",
    });
    const r = await h.kb_search({ query: "incident rollback", limit: 3 });
    expect(r.results[0]).toMatchObject({
      slug: "release-freeze",
      title: "Release Freeze",
      kind: "kb",
    });
  });

  it("kb_taxonomy returns reusable normalized tags and categories", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.kb_create({
      slug: "runtime-plan",
      title: "Runtime Plan",
      body: "body",
      category: "exec-plan",
      tags: ["Jetpack.com", "exec-plan"],
    });

    const r = await h.kb_taxonomy({});
    expect(r.categories).toContainEqual({ category: "plans", count: 1 });
    expect(r.tags).toContainEqual({ tag: "jetpack-com", count: 1 });
    expect(r.tags).toContainEqual({ tag: "execplan", count: 1 });
  });

  // ── toolDefinitions count ────────────────────────────────────────────────

  it("toolDefinitions includes run log, KB, and search tools", () => {
    const kbTools = ["run_log_read", "worktree_sync", "kb_create", "kb_update", "kb_delete", "kb_read", "kb_list", "kb_search", "kb_taxonomy", "journal_search", "memory_search"];
    const names = toolDefinitions.map((t) => t.name);
    for (const name of kbTools) {
      expect(names).toContain(name);
    }
    expect(toolDefinitions.find((t) => t.name === "kb_create")?.description).toContain("preserve durable, reusable deliverables");
    expect(toolDefinitions.find((t) => t.name === "kb_create")?.description).toContain("user-requested artifacts");
    expect(toolDefinitions.find((t) => t.name === "kb_create")?.description).toContain("reuse existing tags");
    expect(toolDefinitions.find((t) => t.name === "kb_create")?.inputSchema.properties).toHaveProperty("related_slugs");
    expect(toolDefinitions.find((t) => t.name === "kb_create")?.inputSchema.properties).toHaveProperty("artifact");
    expect(toolDefinitions.find((t) => t.name === "kb_create")?.description).toContain("Knowledge Base, not kilobytes");
    expect(toolDefinitions.find((t) => t.name === "kb_create")?.outputSchema?.required).toContain("slug");
    expect(toolDefinitions.find((t) => t.name === "kb_read")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(toolDefinitions.find((t) => t.name === "kb_delete")?.annotations).toMatchObject({ destructiveHint: true });
  });

  it("toolDefinitions has 19 total entries (4 existing + 2 todo + worktree sync + agent create + 6 KB + 3 search + 2 subtask graph)", () => {
    expect(toolDefinitions.length).toBe(19);
    // Snapshot-style guard against drift after the per-domain split.
    const names = toolDefinitions.map((tool) => tool.name);
    expect(new Set(names).size).toBe(toolDefinitions.length);
  });
});
