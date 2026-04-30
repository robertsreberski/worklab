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

export const definitions = [
  tool("worklab_kb_list", "List Worklab Knowledge Base entries. In Worklab tool names, `kb` means Knowledge Base, not kilobytes.", object({
    tag: string("Tag filter"),
    category: string("Category filter"),
    pinned: boolean("Pinned filter"),
  })),
  tool("worklab_kb_read", "Read a Worklab Knowledge Base entry.", object({ slug: slugSchema }, ["slug"])),
  tool("worklab_kb_create", "Create a Worklab Knowledge Base entry.", object({
    slug: slugSchema,
    title: string("Title"),
    body: string("Markdown body"),
    tags: arrayOfString("Tags"),
    category: string("Category"),
    pinned: boolean("Pinned"),
  }, ["title"])),
  tool("worklab_kb_update", "Patch a Worklab Knowledge Base entry.", object({ slug: slugSchema, patch: patchSchema }, ["slug", "patch"])),
  tool("worklab_kb_delete", "Delete a Worklab Knowledge Base entry.", object({ slug: slugSchema }, ["slug"])),
  tool("worklab_search", "Search the Worklab Knowledge Base, journals, and memories.", object({
    query: string("Search query"),
    kind: string("all, kb, journal, or memory"),
    agent: string("Optional agent scope"),
    limit: number("Max results"),
  }, ["query"])),
];

const specs = [
  ["worklab_kb_list", "GET", "/api/kb", ["tag", "category", "pinned"]],
  ["worklab_kb_read", "GET", "/api/kb/:slug"],
  ["worklab_kb_create", "POST", "/api/kb", [], "input"],
  ["worklab_kb_update", "PATCH", "/api/kb/:slug", [], "patch"],
  ["worklab_kb_delete", "DELETE", "/api/kb/:slug"],
];

export function buildHandlers(client) {
  const handlers = buildSpecHandlers(client, specs);

  handlers.worklab_search = async (input = {}) => apiRequest(client, "GET", "/api/search", {
    query: {
      q: input.query,
      kind: input.kind || "all",
      agent: input.agent,
      limit: input.limit,
    },
  });

  return handlers;
}
