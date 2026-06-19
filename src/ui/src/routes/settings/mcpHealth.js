import { mcpServerFromRow } from "./helpers.js";

export const MCP_HEALTH_ALL_KEY = "__all";

export function mcpHealthRowKey(id) {
  return `row:${id}`;
}

export function mcpHealthBuiltinKey(name) {
  return `builtin:${name}`;
}

function localMcpHealthError(row, message) {
  return {
    name: row.name || "Draft",
    source: "draft",
    transport: row.transport || "stdio",
    health: "error",
    static_available: false,
    message,
    duration_ms: 0,
    tool_count: 0,
    tools_preview: [],
  };
}

export function mcpHealthMeta(result) {
  if (!result) return null;
  if (result.health === "ok") return { status: "enabled", label: "Healthy" };
  if (result.health === "disabled") return { status: "disabled", label: "Disabled" };
  return { status: "error", label: "Check failed" };
}

export function mcpHealthDetail(result) {
  if (!result) return "";
  const parts = [result.message || (result.health === "ok" ? "Connected" : "Health check failed")];
  if (Number.isFinite(Number(result.duration_ms))) parts.push(`${Math.round(Number(result.duration_ms))}ms`);
  if (result.health === "ok" && result.tools_preview?.length) {
    parts.push(`Tools: ${result.tools_preview.join(", ")}`);
  }
  return parts.filter(Boolean).join(" / ");
}

export function buildMcpHealthDraft(rows = []) {
  const servers = {};
  const rowByName = new Map();
  const rowsByName = new Map();
  const errors = {};
  for (const row of rows) {
    try {
      const { name, config } = mcpServerFromRow(row);
      const duplicate = rowsByName.get(name);
      if (duplicate) {
        const message = `Duplicate MCP server name: ${name}`;
        errors[mcpHealthRowKey(duplicate.id)] = localMcpHealthError(duplicate, message);
        errors[mcpHealthRowKey(row.id)] = localMcpHealthError(row, message);
        delete servers[name];
        rowByName.delete(name);
        continue;
      }
      rowsByName.set(name, row);
      rowByName.set(name, row.id);
      servers[name] = config;
    } catch (err) {
      errors[mcpHealthRowKey(row.id)] = localMcpHealthError(row, err.message || String(err));
    }
  }
  return { servers, rowByName, errors };
}
