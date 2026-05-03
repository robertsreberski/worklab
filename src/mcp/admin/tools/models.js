// Model catalog admin tools.

import {
  boolean,
  compactModelAvailable,
  number,
  object,
  string,
  tool,
} from "../../shared/schema-helpers.js";
import { apiRequest, buildSpecHandlers } from "../../shared/tool-registry.js";

export const definitions = [
  tool("worklab_model_available", "List compact model choices. Use provider/model detail tools or worklab_api_request for full raw metadata.", object({
    q: string("Search query"),
    sdk: string("Filter by runtime SDK or provider family, for example pi, claude, openai-codex, or a custom provider id"),
    available: boolean("Filter by availability"),
    limit: number("Max models to return"),
  })),
  tool("worklab_model_embeddings", "List embedding model options."),
];

const specs = [
  ["worklab_model_embeddings", "GET", "/api/models/embeddings"],
];

export function buildHandlers(client) {
  const handlers = buildSpecHandlers(client, specs);

  handlers.worklab_model_available = async (input = {}) => compactModelAvailable(
    await apiRequest(client, "GET", "/api/models/available"),
    input,
  );

  return handlers;
}
