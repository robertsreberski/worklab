// Custom-provider admin tools.

import {
  idSchema,
  object,
  patchSchema,
  string,
  tool,
} from "../../shared/schema-helpers.js";
import { buildSpecHandlers } from "../../shared/tool-registry.js";

export const definitions = [
  tool("worklab_provider_list", "List custom providers."),
  tool("worklab_provider_get", "Get a custom provider.", object({ id: idSchema }, ["id"])),
  tool("worklab_provider_create", "Create a custom provider.", object({}, ["name", "provider_type"], true)),
  tool("worklab_provider_update", "Patch a custom provider.", object({ id: idSchema, patch: patchSchema }, ["id", "patch"])),
  tool("worklab_provider_delete", "Delete a custom provider.", object({ id: idSchema }, ["id"])),
  tool("worklab_provider_test", "Test a custom provider connection.", object({ id: idSchema }, ["id"])),
  tool("worklab_provider_discover", "Discover models for a custom provider.", object({ id: idSchema }, ["id"])),
  tool("worklab_provider_models", "List models for a custom provider.", object({ id: idSchema }, ["id"])),
  tool("worklab_provider_model_update", "Patch a provider model.", object({ id: idSchema, modelId: string("Model row id"), patch: patchSchema }, ["id", "modelId", "patch"])),
];

const specs = [
  ["worklab_provider_list", "GET", "/api/providers"],
  ["worklab_provider_get", "GET", "/api/providers/:id"],
  ["worklab_provider_create", "POST", "/api/providers", [], "input"],
  ["worklab_provider_update", "PATCH", "/api/providers/:id", [], "patch"],
  ["worklab_provider_delete", "DELETE", "/api/providers/:id"],
  ["worklab_provider_test", "POST", "/api/providers/:id/test"],
  ["worklab_provider_discover", "POST", "/api/providers/:id/discover"],
  ["worklab_provider_models", "GET", "/api/providers/:id/models"],
  ["worklab_provider_model_update", "PATCH", "/api/providers/:id/models/:modelId", [], "patch"],
];

export function buildHandlers(client) {
  return buildSpecHandlers(client, specs);
}
