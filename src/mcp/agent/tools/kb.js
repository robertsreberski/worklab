// Knowledge Base tools available to agents during a run. In Worklab tool
// names, `kb` is short for "Knowledge Base", not "kilobytes".

import { z } from "zod";
import { withDb } from "./shared.js";
import {
  indexPath,
  kbCreate,
  kbDelete,
  kbList,
  kbPath,
  kbRead,
  kbUpdate,
  removeSource,
  search,
} from "../../../core/index.js";

export const kbCreateSchema = z.object({
  slug: z.string().min(1, "slug is required"),
  title: z.string().min(1, "title is required"),
  body: z.string(),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

// Only these 5 keys may appear in a patch — .strict() rejects any unknown keys.
export const kbPatchSchema = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    category: z.string().nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

export const kbUpdateSchema = z.object({
  slug: z.string().min(1, "slug is required"),
  patch: kbPatchSchema,
});

export const kbDeleteSchema = z.object({
  slug: z.string().min(1, "slug is required"),
});

export const kbReadSchema = z.object({
  slug: z.string().min(1, "slug is required"),
});

export const kbListSchema = z.object({
  tag: z.string().optional(),
  category: z.string().optional(),
  pinned: z.boolean().optional(),
});

export const kbSearchSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.number().int().min(1).max(50).optional(),
});

async function bestEffortIndexKb(dataDir, slug) {
  try {
    await withDb(dataDir, (db) => indexPath({ db, dataDir, filePath: kbPath(dataDir, slug) }));
  } catch { /* watcher/startup indexer will retry */ }
}

export const definitions = [
  {
    name: "kb_create",
    description:
      "Create a new Worklab Knowledge Base entry. In this tool name, `kb` means Knowledge Base, not kilobytes. Use this to preserve substantial task deliverables, research reports, runbooks, decisions, and reusable analysis. The author is set automatically from the calling agent context.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "URL-safe identifier (lowercase letters, digits, hyphens; e.g. 'my-note')",
        },
        title: { type: "string", description: "Human-readable title for the entry" },
        body: { type: "string", description: "Markdown body content" },
        tags: { type: "array", items: { type: "string" }, description: "Optional list of tag strings" },
        category: {
          type: "string",
          nullable: true,
          description: "Optional category string (null to omit)",
        },
        pinned: { type: "boolean", description: "Whether the entry is pinned (default false)" },
      },
      required: ["slug", "title", "body"],
    },
  },
  {
    name: "kb_update",
    description:
      "Update fields of an existing Worklab Knowledge Base entry by slug. Only title, body, tags, category, and pinned may be patched; unknown keys are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug of the entry to update" },
        patch: {
          type: "object",
          description: "Fields to update. Allowed keys: title, body, tags, category, pinned.",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            category: { type: "string", nullable: true },
            pinned: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["slug", "patch"],
    },
  },
  {
    name: "kb_delete",
    description: "Delete a Worklab Knowledge Base entry by slug. Throws not_found if the entry does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug of the entry to delete" },
      },
      required: ["slug"],
    },
  },
  {
    name: "kb_read",
    description:
      "Read a Worklab Knowledge Base entry by slug, returning its frontmatter metadata and body. Throws not_found if missing.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug of the entry to read" },
      },
      required: ["slug"],
    },
  },
  {
    name: "kb_list",
    description:
      "List Worklab Knowledge Base entries, optionally filtered by tag, category, or pinned status. Returns metadata only (no body). Sorted: pinned first, then by updated_at descending.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Filter to entries that include this tag" },
        category: { type: "string", description: "Filter to entries with this category" },
        pinned: { type: "boolean", description: "Filter to pinned (true) or unpinned (false) entries" },
      },
    },
  },
  {
    name: "kb_search",
    description: "Search the Worklab Knowledge Base with hybrid FTS/semantic search. Returns compact snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
];

export function buildHandlers(context) {
  const { dataDir, agent } = context;
  return {
    async kb_create(input) {
      const { slug, title, body, tags, category, pinned } = kbCreateSchema.parse(input);
      // author is always sourced from context.agent — never from caller input
      kbCreate({ dataDir, slug, title, body, tags, category, pinned, author: agent });
      await bestEffortIndexKb(dataDir, slug);
      return { ok: true, slug };
    },
    async kb_update(input) {
      const { slug, patch } = kbUpdateSchema.parse(input);
      const existing = kbRead({ dataDir, slug });
      if (existing === null) throw new Error(`not_found: ${slug}`);
      kbUpdate({ dataDir, slug, patch });
      await bestEffortIndexKb(dataDir, slug);
      return { ok: true };
    },
    async kb_delete(input) {
      const { slug } = kbDeleteSchema.parse(input);
      const deleted = kbDelete({ dataDir, slug });
      if (!deleted) throw new Error(`not_found: ${slug}`);
      await withDb(dataDir, (db) => removeSource({ db, kind: "kb", sourceRef: `knowledge/${slug}.md` })).catch(() => {});
      return { ok: true };
    },
    async kb_read(input) {
      const { slug } = kbReadSchema.parse(input);
      const entry = kbRead({ dataDir, slug });
      if (entry === null) throw new Error(`not_found: ${slug}`);
      return { meta: entry.meta, body: entry.body };
    },
    async kb_list(input) {
      const { tag, category, pinned } = kbListSchema.parse(input);
      const entries = kbList({ dataDir, tag, category, pinned });
      return { entries };
    },
    async kb_search(input) {
      const { query, limit } = kbSearchSchema.parse(input);
      const results = await withDb(dataDir, (db) => search({ db, dataDir, query, kind: "kb", limit: limit || 8 }));
      return { results };
    },
  };
}
