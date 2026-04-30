// Skill admin tools.

import {
  object,
  patchSchema,
  string,
  tool,
} from "../../shared/schema-helpers.js";
import { buildSpecHandlers } from "../../shared/tool-registry.js";

export const definitions = [
  tool("worklab_skill_list", "List skills."),
  tool("worklab_skill_get", "Get a skill.", object({ name: string("Skill name") }, ["name"])),
  tool("worklab_skill_create", "Create a skill.", object({ name: string("Skill name"), meta: patchSchema, body: string("Skill body") })),
  tool("worklab_skill_update", "Patch a skill.", object({ name: string("Skill name"), patch: patchSchema }, ["name", "patch"])),
  tool("worklab_skill_delete", "Delete a skill.", object({ name: string("Skill name") }, ["name"])),
  tool("worklab_skill_usage", "List agents that can use a skill.", object({ name: string("Skill name") }, ["name"])),
];

const specs = [
  ["worklab_skill_list", "GET", "/api/skills"],
  ["worklab_skill_get", "GET", "/api/skills/:name"],
  ["worklab_skill_create", "POST", "/api/skills", [], "input"],
  ["worklab_skill_update", "PATCH", "/api/skills/:name", [], "skillPatch"],
  ["worklab_skill_delete", "DELETE", "/api/skills/:name"],
  ["worklab_skill_usage", "GET", "/api/skills/:name/usage"],
];

export function buildHandlers(client) {
  return buildSpecHandlers(client, specs);
}
