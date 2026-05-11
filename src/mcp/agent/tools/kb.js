// Knowledge Base tools available to agents during a run. In Worklab tool
// names, `kb` is short for "Knowledge Base", not "kilobytes".

import { z } from "zod";
import { withDb } from "./shared.js";
import {
  KB_SORT_MODES,
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
  subcategory: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  source_task_id: z.string().nullable().optional(),
  source_task_key: z.string().nullable().optional(),
  source_run_id: z.string().nullable().optional(),
  source_agent: z.string().nullable().optional(),
  related_slugs: z.array(z.string()).optional(),
  supersedes_slugs: z.array(z.string()).optional(),
  canonical_slug: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

// Only these 5 keys may appear in a patch — .strict() rejects any unknown keys.
export const kbPatchSchema = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    category: z.string().nullable().optional(),
    subcategory: z.string().nullable().optional(),
    project_id: z.string().nullable().optional(),
    source_task_id: z.string().nullable().optional(),
    source_task_key: z.string().nullable().optional(),
    source_run_id: z.string().nullable().optional(),
    source_agent: z.string().nullable().optional(),
    related_slugs: z.array(z.string()).optional(),
    supersedes_slugs: z.array(z.string()).optional(),
    canonical_slug: z.string().nullable().optional(),
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
  subcategory: z.string().optional(),
  project_id: z.string().optional(),
  pinned: z.boolean().optional(),
  sort: z.enum(KB_SORT_MODES).optional(),
});

export const kbSearchSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.number().int().min(1).max(50).optional(),
  tag: z.string().optional(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  project_id: z.string().optional(),
});

async function bestEffortIndexKb(dataDir, slug) {
  try {
    await withDb(dataDir, (db) => indexPath({ db, dataDir, filePath: kbPath(dataDir, slug) }));
  } catch { /* watcher/startup indexer will retry */ }
}

const okSlugOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    slug: { type: "string" },
  },
  required: ["ok", "slug"],
  additionalProperties: false,
};

const okOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
  },
  required: ["ok"],
  additionalProperties: false,
};

export const definitions = [
  {
    name: "kb_create",
    description:
      "Create a new Worklab Knowledge Base entry. In this tool name, `kb` means Knowledge Base, not kilobytes. Use this to preserve durable, reusable deliverables such as research reports, runbooks, decisions, and canonical analysis. Do not create entries for routine run results or one-off status updates. Prefer kb_update when a related canonical entry already exists. The author is set automatically from the calling agent context.",
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
        subcategory: {
          type: "string",
          nullable: true,
          description: "Optional topic/workstream within the category (null to omit)",
        },
        project_id: {
          type: "string",
          nullable: true,
          description: "Optional Worklab project id. Omit to inherit the current task project; use null for global knowledge.",
        },
        source_task_id: {
          type: "string",
          nullable: true,
          description: "Optional source task id for promoted task output.",
        },
        source_task_key: {
          type: "string",
          nullable: true,
          description: "Optional human task key such as T-123 for promoted task output.",
        },
        source_run_id: {
          type: "string",
          nullable: true,
          description: "Optional source run id for promoted run output.",
        },
        source_agent: {
          type: "string",
          nullable: true,
          description: "Optional source agent name.",
        },
        related_slugs: {
          type: "array",
          items: { type: "string" },
          description: "Optional related Knowledge Base slugs.",
        },
        supersedes_slugs: {
          type: "array",
          items: { type: "string" },
          description: "Optional older Knowledge Base slugs superseded by this entry.",
        },
        canonical_slug: {
          type: "string",
          nullable: true,
          description: "Optional canonical Knowledge Base slug when this entry points to or updates a canonical page.",
        },
        pinned: { type: "boolean", description: "Whether the entry is pinned (default false)" },
      },
      required: ["slug", "title", "body"],
    },
    outputSchema: okSlugOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "kb_update",
    description:
      "Update fields of an existing Worklab Knowledge Base entry by slug. Only title, body, tags, category, subcategory, project_id, and pinned may be patched; unknown keys are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug of the entry to update" },
        patch: {
          type: "object",
          description: "Fields to update. Allowed keys: title, body, tags, category, subcategory, project_id, source metadata, relationships, and pinned.",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            category: { type: "string", nullable: true },
            subcategory: { type: "string", nullable: true },
            project_id: { type: "string", nullable: true },
            source_task_id: { type: "string", nullable: true },
            source_task_key: { type: "string", nullable: true },
            source_run_id: { type: "string", nullable: true },
            source_agent: { type: "string", nullable: true },
            related_slugs: { type: "array", items: { type: "string" } },
            supersedes_slugs: { type: "array", items: { type: "string" } },
            canonical_slug: { type: "string", nullable: true },
            pinned: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["slug", "patch"],
    },
    outputSchema: okOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
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
    outputSchema: okOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
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
    annotations: { readOnlyHint: true },
  },
  {
    name: "kb_list",
    description:
      "List Worklab Knowledge Base entries, optionally filtered by project, category, subcategory, tag, or pinned status. Returns metadata only (no body). Default sort is recent update; available sort modes are updated_desc, pinned_first, title_asc, and project_category.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Filter to entries that include this tag" },
        project_id: { type: "string", description: "Filter to entries linked to this Worklab project id" },
        category: { type: "string", description: "Filter to entries with this category" },
        subcategory: { type: "string", description: "Filter to entries with this subcategory" },
        pinned: { type: "boolean", description: "Filter to pinned (true) or unpinned (false) entries" },
        sort: {
          type: "string",
          enum: KB_SORT_MODES,
          description: "Sort mode: updated_desc, pinned_first, title_asc, or project_category",
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "kb_search",
    description: "Search the Worklab Knowledge Base with hybrid FTS/semantic search. Returns compact snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
        tag: { type: "string", description: "Filter to entries that include this tag" },
        project_id: { type: "string", description: "Filter to entries linked to this Worklab project id" },
        category: { type: "string", description: "Filter to entries with this category" },
        subcategory: { type: "string", description: "Filter to entries with this subcategory" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
];

export function buildHandlers(context) {
  const { dataDir, agent, projectId } = context;
  return {
    async kb_create(input) {
      const {
        slug,
        title,
        body,
        tags,
        category,
        subcategory,
        pinned,
        source_task_id,
        source_task_key,
        source_run_id,
        source_agent,
        related_slugs,
        supersedes_slugs,
        canonical_slug,
      } = kbCreateSchema.parse(input);
      const project_id = Object.prototype.hasOwnProperty.call(input || {}, "project_id")
        ? input.project_id
        : (projectId || null);
      // author is always sourced from context.agent — never from caller input
      kbCreate({
        dataDir,
        slug,
        title,
        body,
        tags,
        category,
        subcategory,
        project_id,
        source_task_id,
        source_task_key,
        source_run_id,
        source_agent,
        related_slugs,
        supersedes_slugs,
        canonical_slug,
        pinned,
        author: agent,
      });
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
      const { tag, category, subcategory, project_id, pinned, sort } = kbListSchema.parse(input);
      const entries = kbList({ dataDir, tag, category, subcategory, project_id, pinned, sort });
      return { entries };
    },
    async kb_search(input) {
      const { query, limit, tag, category, subcategory, project_id } = kbSearchSchema.parse(input);
      const results = await withDb(dataDir, (db) => search({
        db,
        dataDir,
        query,
        kind: "kb",
        tag,
        category,
        subcategory,
        project_id,
        limit: limit || 8,
      }));
      return { results };
    },
  };
}
