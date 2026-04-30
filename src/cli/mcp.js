import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, worklabBaseUrl } from "../core/config.js";
import { readMcpToken } from "../core/service-token.js";
import { adminToolDefinitions, createAdminToolHandlers } from "../mcp/admin/tools.js";
import { applyConfigArgs } from "./args.js";

function authFetch(token) {
  return (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  };
}

export async function mcp(args = []) {
  applyConfigArgs(args);
  const config = loadConfig();
  const token = readMcpToken(config.dataDir);
  const handlers = createAdminToolHandlers({
    baseUrl: worklabBaseUrl(config),
    config,
    fetchImpl: authFetch(token),
  });

  const server = new Server(
    { name: "worklab-admin-stdio", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: "Full-access local Worklab administration MCP bridge.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: adminToolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const handler = handlers[name];
    if (!handler) throw new Error(`unknown tool: ${name}`);
    const result = await handler(args || {});
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  await server.connect(new StdioServerTransport());
}
