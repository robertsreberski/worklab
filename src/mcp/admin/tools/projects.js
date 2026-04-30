// Project admin tools.

import {
  arrayOfString,
  boolean,
  object,
  patchSchema,
  projectIdSchema,
  string,
  tool,
} from "../../shared/schema-helpers.js";
import { buildSpecHandlers } from "../../shared/tool-registry.js";

export const definitions = [
  tool("worklab_project_list", "List projects, optionally including archived projects.", object({
    q: string("Search query"),
    include_archived: boolean("Include archived projects"),
  })),
  tool("worklab_project_get", "Get a project with task summary and stage counts.", object({ id: projectIdSchema }, ["id"])),
  tool("worklab_project_create", "Create a project.", object({
    name: string("Project name"),
    slug: string("Optional URL-safe slug"),
    description: string("Short project description"),
    context: string("Markdown context inserted into every assigned task run"),
    workdir: string("Optional run workdir override"),
    tags: arrayOfString("Tags"),
    archived: boolean("Whether the project starts archived"),
  }, ["name"])),
  tool("worklab_project_update", "Patch a project.", object({ id: projectIdSchema, patch: patchSchema }, ["id", "patch"])),
  tool("worklab_project_archive", "Archive a project without deleting linked tasks.", object({ id: projectIdSchema }, ["id"])),
];

const specs = [
  ["worklab_project_list", "GET", "/api/projects", ["q", "include_archived"]],
  ["worklab_project_get", "GET", "/api/projects/:id"],
  ["worklab_project_create", "POST", "/api/projects", [], "input"],
  ["worklab_project_update", "PATCH", "/api/projects/:id", [], "patch"],
  ["worklab_project_archive", "DELETE", "/api/projects/:id"],
];

export function buildHandlers(client) {
  return buildSpecHandlers(client, specs);
}
