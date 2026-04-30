// Automation admin tools.

import {
  idSchema,
  object,
  patchSchema,
  tool,
} from "../../shared/schema-helpers.js";
import { buildSpecHandlers } from "../../shared/tool-registry.js";

export const definitions = [
  tool("worklab_automation_list", "List automations."),
  tool("worklab_automation_get", "Get an automation.", object({ id: idSchema }, ["id"])),
  tool("worklab_automation_create", "Create an automation.", object({}, ["title"], true)),
  tool("worklab_automation_update", "Patch an automation.", object({ id: idSchema, patch: patchSchema }, ["id", "patch"])),
  tool("worklab_automation_delete", "Delete an automation.", object({ id: idSchema }, ["id"])),
  tool("worklab_automation_run", "Run an automation once now.", object({ id: idSchema }, ["id"])),
];

const specs = [
  ["worklab_automation_list", "GET", "/api/automations"],
  ["worklab_automation_get", "GET", "/api/automations/:id"],
  ["worklab_automation_create", "POST", "/api/automations", [], "input"],
  ["worklab_automation_update", "PATCH", "/api/automations/:id", [], "patch"],
  ["worklab_automation_delete", "DELETE", "/api/automations/:id"],
  ["worklab_automation_run", "POST", "/api/automations/:id/run"],
];

export function buildHandlers(client) {
  return buildSpecHandlers(client, specs);
}
