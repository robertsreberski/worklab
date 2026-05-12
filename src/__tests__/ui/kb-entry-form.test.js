import { describe, expect, it } from "vitest";
import { kbFormEntryFromQuery, normalizeKbEntry, normalizeKbFormEntry } from "../../ui/src/routes/kb-entry-form.js";

describe("normalizeKbFormEntry", () => {
  it("flattens nested KB API responses for the edit form", () => {
    expect(normalizeKbFormEntry({
      meta: {
        slug: "welcome",
        title: "Welcome",
        category: "guide",
        subcategory: "runtime",
        project_id: "proj-1",
        tags: ["intro", "setup"],
        pinned: true,
        source_task_id: "task-1",
        source_task_key: "T-1",
        source_run_id: "run-1",
        source_agent: "agent-one",
        related_slugs: ["related"],
        supersedes_slugs: ["old"],
        canonical_slug: "welcome",
      },
      project: { id: "proj-1", slug: "project-one", name: "Project One" },
      body: "# Hello",
    })).toEqual({
      slug: "welcome",
      title: "Welcome",
      category: "guide",
      subcategory: "runtime",
      project_id: "proj-1",
      tags: ["intro", "setup"],
      pinned: true,
      source_task_id: "task-1",
      source_task_key: "T-1",
      source_run_id: "run-1",
      source_agent: "agent-one",
      related_slugs: ["related"],
      supersedes_slugs: ["old"],
      canonical_slug: "welcome",
      body: "# Hello",
    });
  });

  it("preserves compatibility with legacy flat KB entry payloads", () => {
    expect(normalizeKbFormEntry({
      slug: "legacy",
      title: "Legacy",
      category: null,
      tags: ["ops"],
      pinned: false,
      source_task_key: "T-9",
      related_slugs: "runbook, decision",
      body: "body",
    })).toEqual({
      slug: "legacy",
      title: "Legacy",
      category: "",
      subcategory: "",
      project_id: "",
      tags: ["ops"],
      pinned: false,
      source_task_id: "",
      source_task_key: "T-9",
      source_run_id: "",
      source_agent: "",
      related_slugs: ["runbook", "decision"],
      supersedes_slugs: [],
      canonical_slug: "",
      body: "body",
    });
  });

  it("normalizes nested KB API responses for read views", () => {
    expect(normalizeKbEntry({
      meta: {
        slug: "welcome",
        title: "Welcome",
        category: null,
        subcategory: null,
        project_id: "proj-1",
        tags: ["intro", "setup"],
        pinned: true,
        author: "human",
        created_at: "2026-04-24T12:00:00Z",
        updated_at: "2026-04-25T12:00:00Z",
        source_run_id: "run-1",
        related_slugs: ["related"],
      },
      project: { id: "proj-1", slug: "project-one", name: "Project One" },
      body: "# Hello",
    })).toEqual({
      slug: "welcome",
      title: "Welcome",
      category: "",
      subcategory: "",
      project_id: "proj-1",
      project: { id: "proj-1", slug: "project-one", name: "Project One" },
      tags: ["intro", "setup"],
      pinned: true,
      author: "human",
      created_at: "2026-04-24T12:00:00Z",
      updated_at: "2026-04-25T12:00:00Z",
      source_task_id: "",
      source_task_key: "",
      source_run_id: "run-1",
      source_agent: "",
      related_slugs: ["related"],
      supersedes_slugs: [],
      canonical_slug: "",
      canonical_entry: null,
      related_entries: [],
      supersedes_entries: [],
      body: "# Hello",
    });
  });

  it("preserves resolved relation entries for badge display labels", () => {
    const entry = normalizeKbEntry({
      meta: {
        slug: "subject-note",
        title: "Subject Note",
        canonical_slug: "canonical-note",
        canonical_entry: { slug: "canonical-note", title: "Canonical Note" },
        related_slugs: ["related-note"],
        related_entries: [{ slug: "related-note", title: "Related Note" }],
        supersedes_slugs: ["old-note"],
        supersedes_entries: [{ slug: "old-note", title: "Old Note" }],
      },
      body: "",
    });

    expect(entry.canonical_entry).toEqual({ slug: "canonical-note", title: "Canonical Note" });
    expect(entry.related_entries).toEqual([{ slug: "related-note", title: "Related Note" }]);
    expect(entry.supersedes_entries).toEqual([{ slug: "old-note", title: "Old Note" }]);
  });
});

describe("kbFormEntryFromQuery", () => {
  it("builds a new-entry prefill from promotion query params", () => {
    expect(kbFormEntryFromQuery({
      title: "Promoted Note",
      body: "Source output",
      category: "research",
      project_id: "project-1",
      source_task_id: "task-1",
      source_task_key: "T-1",
      source_run_id: "run-1",
      source_agent: "coder",
      related_slugs: "runbook,decision",
      tags: "promoted,project",
    })).toMatchObject({
      title: "Promoted Note",
      body: "Source output",
      category: "research",
      project_id: "project-1",
      source_task_id: "task-1",
      source_task_key: "T-1",
      source_run_id: "run-1",
      source_agent: "coder",
      related_slugs: ["runbook", "decision"],
      tags: ["promoted", "project"],
    });
  });
});
