// Knowledge Base + cross-corpus search admin tools. In Worklab tool names,
// `kb` is short for "Knowledge Base", not "kilobytes".

import {
  arrayOfString,
  boolean,
  number,
  object,
  patchSchema,
  slugSchema,
  string,
  tool,
} from "../../shared/schema-helpers.js";
import { apiRequest, buildSpecHandlers } from "../../shared/tool-registry.js";

const KB_SORT_MODES = ["updated_desc", "pinned_first", "title_asc", "project_category"];

export const definitions = [
  tool("worklab_kb_list", "List Worklab Knowledge Base entries. In Worklab tool names, `kb` means Knowledge Base, not kilobytes.", object({
    tag: string("Tag filter"),
    project_id: string("Project id or slug filter"),
    category: string("Category filter"),
    subcategory: string("Subcategory filter"),
    pinned: boolean("Pinned filter"),
    sort: { ...string("Sort mode"), enum: KB_SORT_MODES },
  }), { annotations: { readOnlyHint: true } }),
  tool("worklab_kb_taxonomy", "List normalized Knowledge Base categories, subcategories, tags, surfaces, and raw alias cleanup candidates. Use this before creating Knowledge so agents reuse existing tags.", object({}), { annotations: { readOnlyHint: true } }),
  tool("worklab_kb_read", "Read a Worklab Knowledge Base entry.", object({ slug: slugSchema }, ["slug"]), { annotations: { readOnlyHint: true } }),
  tool("worklab_kb_create", "Create a Worklab Knowledge Base entry for explicitly requested durable artifacts; save plans only when the human explicitly asks; search/taxonomy should be checked first so similar tags and entries are reused.", object({
    slug: slugSchema,
    title: string("Title"),
    body: string("Markdown body"),
    tags: arrayOfString("Tags"),
    category: string("Category"),
    subcategory: string("Subcategory"),
    artifact: boolean("Override whether this appears in the default Artifacts surface"),
    project_id: string("Project id or slug"),
    source_task_id: string("Source task id"),
    source_task_key: string("Source task key"),
    source_run_id: string("Source run id"),
    source_agent: string("Source agent name"),
    related_slugs: arrayOfString("Related Knowledge Base slugs"),
    supersedes_slugs: arrayOfString("Superseded Knowledge Base slugs"),
    canonical_slug: string("Canonical Knowledge Base slug"),
    pinned: boolean("Pinned"),
  }, ["title"]), { annotations: { readOnlyHint: false, destructiveHint: false } }),
  tool("worklab_kb_update", "Patch a Worklab Knowledge Base entry.", object({ slug: slugSchema, patch: patchSchema }, ["slug", "patch"]), { annotations: { readOnlyHint: false, destructiveHint: false } }),
  tool("worklab_kb_delete", "Delete a Worklab Knowledge Base entry.", object({ slug: slugSchema }, ["slug"]), { annotations: { readOnlyHint: false, destructiveHint: true } }),
  tool("worklab_kb_organize", "Preview or apply conservative Knowledge Base project/category/subcategory metadata backfill. Defaults to dry-run unless apply is true.", object({
    apply: boolean("Apply proposed metadata changes. Defaults to false for dry-run."),
  }), { annotations: { readOnlyHint: false, destructiveHint: false } }),
  tool("worklab_kb_cleanup_auto_promoted", "Preview or delete generated auto-promoted run-result Knowledge Base assets. Defaults to dry-run unless apply is true.", object({
    apply: boolean("Delete candidate entries. Defaults to false for dry-run."),
  }), { annotations: { readOnlyHint: false, destructiveHint: true } }),
  tool("worklab_search", "Search the Worklab Knowledge Base, journals, and memories.", object({
    query: string("Search query"),
    kind: string("all, kb, journal, or memory"),
    agent: string("Optional agent scope"),
    tag: string("Optional KB tag filter"),
    project_id: string("Optional KB project id filter"),
    category: string("Optional KB category filter"),
    subcategory: string("Optional KB subcategory filter"),
    limit: number("Max results"),
  }, ["query"]), { annotations: { readOnlyHint: true } }),
];

const specs = [
  ["worklab_kb_list", "GET", "/api/kb", ["tag", "project_id", "category", "subcategory", "pinned", "sort"]],
  ["worklab_kb_taxonomy", "GET", "/api/kb/taxonomy"],
  ["worklab_kb_read", "GET", "/api/kb/:slug"],
  ["worklab_kb_create", "POST", "/api/kb", [], "input"],
  ["worklab_kb_update", "PATCH", "/api/kb/:slug", [], "patch"],
  ["worklab_kb_delete", "DELETE", "/api/kb/:slug"],
  ["worklab_kb_organize", "POST", "/api/kb/organize", [], "input"],
  ["worklab_kb_cleanup_auto_promoted", "POST", "/api/kb/cleanup-auto-promoted", [], "input"],
];

export function buildHandlers(client) {
  const handlers = buildSpecHandlers(client, specs);

  handlers.worklab_search = async (input = {}) => apiRequest(client, "GET", "/api/search", {
    query: {
      q: input.query,
      kind: input.kind || "all",
      agent: input.agent,
      tag: input.tag,
      project_id: input.project_id,
      category: input.category,
      subcategory: input.subcategory,
      limit: input.limit,
    },
  });

  return handlers;
}
