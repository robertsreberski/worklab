// Agent admin tools.

import {
  arrayOfString,
  boolean,
  compactAgent,
  compactAgentList,
  number,
  object,
  patchSchema,
  string,
  tool,
} from "../../shared/schema-helpers.js";
import { apiRequest, buildSpecHandlers } from "../../shared/tool-registry.js";

const agentCreateInput = object({
  name: string("Optional lowercase slug. If omitted, Worklab generates one from display_name."),
  display_name: string("Agent display name"),
  model: string("Explicit model reference, for example codex:gpt-5.5 or claude:claude-sonnet-4-6"),
  effort: string("Reasoning effort: none, low, medium, high, xhigh, or max"),
  description: string("Short description"),
  instructions: string("Agent instructions"),
  skills_allowlist: arrayOfString("Allowed skills when skills_allowlist_mode is custom"),
  skills_allowlist_mode: string("Skill allowlist mode: all or custom"),
  mcp_allowlist: arrayOfString("Allowed MCP servers when mcp_allowlist_mode is custom"),
  mcp_allowlist_mode: string("MCP allowlist mode: all or custom"),
  builtin_allowlist: arrayOfString("Allowed built-in tools when builtin_allowlist_mode is custom"),
  builtin_allowlist_mode: string("Built-in allowlist mode: all or custom"),
  allow_self_review: boolean("Whether the agent may review its own runs"),
  daily_budget_usd: number("Daily budget in USD"),
  per_run_budget_usd: number("Per-run budget in USD"),
  enabled: boolean("Whether the agent is enabled"),
}, ["display_name", "model"]);

export const definitions = [
  tool("worklab_agent_list", "List compact agent summaries. Use worklab_agent_get for full instructions and detailed allowlists.", object({
    q: string("Search query"),
    enabled: boolean("Filter by enabled state"),
    limit: number("Max agents to return"),
  })),
  tool("worklab_agent_get", "Get an agent.", object({ name: string("Agent name") }, ["name"])),
  tool("worklab_agent_create", "Create an agent and return a compact agent summary.", agentCreateInput),
  tool("worklab_agent_update", "Patch an agent. Use fields accepted by PATCH /api/agents/:name.", object({ name: string("Agent name"), patch: patchSchema }, ["name", "patch"])),
  tool("worklab_agent_delete", "Delete an agent.", object({ name: string("Agent name") }, ["name"])),
  tool("worklab_agent_consolidate", "Start forced memory consolidation for an agent.", object({ name: string("Agent name") }, ["name"])),
  tool("worklab_agent_runs", "List recent runs for an agent.", object({ name: string("Agent name"), limit: number("Max runs") }, ["name"])),
  tool("worklab_agent_journal", "Read the journal section for a specific run.", object({ name: string("Agent name"), run: string("Run id") }, ["name", "run"])),
];

const specs = [
  ["worklab_agent_get", "GET", "/api/agents/:name"],
  ["worklab_agent_update", "PATCH", "/api/agents/:name", [], "patch"],
  ["worklab_agent_delete", "DELETE", "/api/agents/:name"],
  ["worklab_agent_consolidate", "POST", "/api/agents/:name/consolidate"],
  ["worklab_agent_runs", "GET", "/api/agents/:name/runs", ["limit"]],
  ["worklab_agent_journal", "GET", "/api/agents/:name/journal", ["run"]],
];

export function buildHandlers(client) {
  const handlers = buildSpecHandlers(client, specs);

  handlers.worklab_agent_list = async (input = {}) => compactAgentList(
    await apiRequest(client, "GET", "/api/agents"),
    input,
  );

  handlers.worklab_agent_create = async (input = {}) => {
    const result = await apiRequest(client, "POST", "/api/agents", { body: input });
    return { agent: compactAgent(result.agent) };
  };

  return handlers;
}
