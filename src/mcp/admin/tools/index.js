// Aggregator for the admin MCP tool surface. Each domain file under this
// directory exports `definitions` (array of tool descriptors) and
// `buildHandlers(client, ctx)` (returns `{ toolName: handler }`). This
// module flattens both, preserving the public exports
// `adminToolDefinitions` and `createAdminToolHandlers` that
// src/mcp/admin/server.js and src/cli/mcp.js consume.

import * as service from "./service.js";
import * as projects from "./projects.js";
import * as teams from "./teams.js";
import * as tasks from "./tasks.js";
import * as agents from "./agents.js";
import * as runs from "./runs.js";
import * as kb from "./kb.js";
import * as skills from "./skills.js";
import * as automations from "./automations.js";
import * as providers from "./providers.js";
import * as models from "./models.js";
import * as settings from "./settings.js";
import * as apiEscape from "./api-escape.js";

// Order matters only for tool-list presentation; keep grouping aligned with
// the original monolithic file so existing snapshots and docs remain stable.
const modules = [
  service,
  projects,
  teams,
  tasks,
  agents,
  runs,
  kb,
  skills,
  automations,
  providers,
  models,
  settings,
  apiEscape,
];

export const adminToolDefinitions = modules.flatMap((mod) => mod.definitions);

export function createAdminToolHandlers({ baseUrl, config, fetchImpl = fetch, token } = {}) {
  const client = { baseUrl, fetchImpl, token };
  const ctx = { config };
  const handlers = {};
  for (const mod of modules) {
    Object.assign(handlers, mod.buildHandlers(client, ctx));
  }
  return handlers;
}

export { apiRequest } from "../../shared/tool-registry.js";
