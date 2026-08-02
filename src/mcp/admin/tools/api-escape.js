// Full-access HTTP escape hatch for admin clients.

import {
  object,
  patchSchema,
  string,
  tool,
} from "../../shared/schema-helpers.js";
import { apiRequest } from "../../shared/tool-registry.js";

function decodedApiPath(value) {
  if (typeof value !== "string") return "";
  try {
    const pathname = new URL(value, "http://worklab.invalid").pathname;
    return decodeURIComponent(pathname).replace(/\/+$/u, "") || "/";
  } catch {
    return "";
  }
}

function isPrivateAcpUrlHandoffPath(value) {
  return /^\/api\/acp\/interactions\/[^/]+\/url:open$/iu.test(decodedApiPath(value));
}

export const definitions = [
  tool("worklab_api_request", "Full-access escape hatch for Worklab HTTP API routes under /api/*, excluding private browser handoffs.", object({
    method: string("HTTP method"),
    path: string("Path beginning with /api/"),
    query: patchSchema,
    body: patchSchema,
  }, ["method", "path"])),
];

export function buildHandlers(client) {
  return {
    worklab_api_request: async (input = {}) => {
      if (isPrivateAcpUrlHandoffPath(input.path)) {
        throw new Error("ACP URL handoffs can only be opened by the Worklab browser UI");
      }
      return apiRequest(client, input.method || "GET", input.path, {
        query: input.query,
        body: input.body,
      });
    },
  };
}
