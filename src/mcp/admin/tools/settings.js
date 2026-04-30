// Settings + external MCP-config admin tools.

import {
  object,
  patchSchema,
  tool,
} from "../../shared/schema-helpers.js";
import { buildSpecHandlers } from "../../shared/tool-registry.js";

export const definitions = [
  tool("worklab_settings_get", "Get Worklab settings."),
  tool("worklab_settings_update", "Patch Worklab settings.", object({ patch: patchSchema }, ["patch"])),
  tool("worklab_mcp_config_get", "Get configured external MCP servers."),
  tool("worklab_mcp_config_set", "Replace configured external MCP servers.", object({ mcpServers: patchSchema }, ["mcpServers"])),
  tool("worklab_mcp_status", "List built-in and configured MCP server availability."),
];

const specs = [
  ["worklab_settings_get", "GET", "/api/settings"],
  ["worklab_settings_update", "PATCH", "/api/settings", [], "patch"],
  ["worklab_mcp_config_get", "GET", "/api/mcp"],
  ["worklab_mcp_config_set", "PUT", "/api/mcp", [], "mcpServers"],
  ["worklab_mcp_status", "GET", "/api/mcp/status"],
];

export function buildHandlers(client) {
  return buildSpecHandlers(client, specs);
}
