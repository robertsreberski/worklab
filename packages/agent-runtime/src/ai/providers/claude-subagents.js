function hasNativeClaudeSubagents(nativeSubagents) {
  return nativeSubagents?.provider === "claude"
    && Array.isArray(nativeSubagents.teammates)
    && nativeSubagents.teammates.length > 0;
}

function claudeSubagentModelAlias(teammate) {
  const raw = [
    teammate?.modelRef,
    teammate?.model?.reference,
    teammate?.model?.model,
  ].filter(Boolean).join(" ").toLowerCase();
  if (raw.includes("opus")) return "opus";
  if (raw.includes("haiku")) return "haiku";
  if (raw.includes("sonnet")) return "sonnet";
  return "inherit";
}

function claudeSubagentMcpServers(mcpServers = {}) {
  const servers = [];
  for (const [name, server] of Object.entries(mcpServers || {})) {
    if (!server || typeof server !== "object") continue;
    servers.push({ [name]: server });
  }
  return servers;
}

function cleanList(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
}

function withTaskTool(tools) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  return cleanList([...tools, "Task"]);
}

export function claudeNativeAgentDefinitions(nativeSubagents) {
  if (!hasNativeClaudeSubagents(nativeSubagents)) return null;
  const definitions = {};
  for (const teammate of nativeSubagents.teammates) {
    const name = String(teammate?.name || "").trim();
    const prompt = String(teammate?.helperSystemPrompt || teammate?.instructions || "").trim();
    if (!name || !prompt) continue;
    const definition = {
      description: String(teammate.description || teammate.displayName || name),
      prompt,
    };
    const tools = cleanList(teammate.allowedTools);
    if (tools.length) definition.tools = tools;
    const disallowedTools = cleanList(teammate.disallowedTools);
    if (disallowedTools.length) definition.disallowedTools = disallowedTools;
    const model = claudeSubagentModelAlias(teammate);
    if (model) definition.model = model;
    const mcpServers = claudeSubagentMcpServers(teammate.mcpServers);
    if (mcpServers.length) definition.mcpServers = mcpServers;
    definitions[name] = definition;
  }
  return Object.keys(definitions).length ? definitions : null;
}

export function claudeToolsWithNativeSubagents(allowedTools, nativeSubagents) {
  return claudeNativeAgentDefinitions(nativeSubagents)
    ? withTaskTool(allowedTools)
    : allowedTools;
}
