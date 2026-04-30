// Run + activity admin tools.

import {
  idSchema,
  number,
  object,
  string,
  tool,
} from "../../shared/schema-helpers.js";
import { buildSpecHandlers } from "../../shared/tool-registry.js";

export const definitions = [
  tool("worklab_run_get", "Get a run and its event log.", object({ id: idSchema }, ["id"])),
  tool("worklab_activity_list", "List recent Worklab activity.", object({
    limit: number("Max items"),
    cursor: number("Pagination cursor"),
    agent: string("Agent filter"),
    status: string("Run status filter"),
    from: string("Start time filter"),
    to: string("End time filter"),
  })),
];

const specs = [
  ["worklab_run_get", "GET", "/api/runs/:id"],
  ["worklab_activity_list", "GET", "/api/activity", ["limit", "cursor", "agent", "status", "from", "to"]],
];

export function buildHandlers(client) {
  return buildSpecHandlers(client, specs);
}
