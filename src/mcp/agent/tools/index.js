// Aggregator for the agent-side MCP tool surface. Each domain file under
// this directory exports `definitions` and `buildHandlers(context)`. The
// public exports `toolDefinitions`, `createToolHandlers`, and
// `renderToolSurfaceMarkdown` keep the same shape src/worker.js,
// src/api/routes/tasks.js, and src/mcp/agent/server.js consume.

import * as memory from "./memory.js";
import * as todos from "./todos.js";
import * as taskGraph from "./tasks.js";
import * as agentMgmt from "./agents.js";
import * as kb from "./kb.js";
import * as worktrees from "./worktrees.js";

// Definition order is preserved from the original monolithic file so
// printed surface listings (and any future snapshot tests) remain stable.
const memoryDefs = memory.definitions;
const journalCore = memoryDefs.filter((tool) => ["journal_append", "journal_summary", "memory_read", "run_log_read"].includes(tool.name));
const memorySearch = memoryDefs.filter((tool) => ["journal_search", "memory_search"].includes(tool.name));

export const toolDefinitions = [
  ...journalCore,
  ...todos.definitions,
  ...taskGraph.definitions,
  ...worktrees.definitions,
  ...agentMgmt.definitions,
  ...kb.definitions,
  ...memorySearch,
];

export function createToolHandlers(context) {
  return {
    ...memory.buildHandlers(context),
    ...todos.buildHandlers(context),
    ...taskGraph.buildHandlers(context),
    ...worktrees.buildHandlers(context),
    ...agentMgmt.buildHandlers(context),
    ...kb.buildHandlers(context),
  };
}

export function renderToolSurfaceMarkdown(toolNames) {
  const allow = toolNames ? new Set(toolNames) : null;
  const visible = toolDefinitions.filter((tool) => !allow || allow.has(tool.name));
  if (visible.length === 0) return "";
  return visible
    .map((tool) => {
      const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
      const params = required.length ? ` (${required.join(", ")})` : "";
      const summary = (tool.description || "").trim().split(/\n+/)[0];
      return `- \`${tool.name}\`${params}: ${summary}`;
    })
    .join("\n");
}
