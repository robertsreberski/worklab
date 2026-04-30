// Full-access HTTP escape hatch for admin clients.

import {
  object,
  patchSchema,
  string,
  tool,
} from "../../shared/schema-helpers.js";
import { apiRequest } from "../../shared/tool-registry.js";

export const definitions = [
  tool("worklab_api_request", "Full-access escape hatch for Worklab HTTP API routes under /api/*.", object({
    method: string("HTTP method"),
    path: string("Path beginning with /api/"),
    query: patchSchema,
    body: patchSchema,
  }, ["method", "path"])),
];

export function buildHandlers(client) {
  return {
    worklab_api_request: async (input = {}) => apiRequest(client, input.method || "GET", input.path, {
      query: input.query,
      body: input.body,
    }),
  };
}
