#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createWebhookToolHandlers, webhookToolDefinitions } from "./index.js";

export function createWebhookMcpServer({ fetchImpl = fetch } = {}) {
  const handlers = createWebhookToolHandlers({ fetchImpl });
  const server = new Server(
    { name: "worklab-webhooks", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: "Send unauthenticated JSON POST requests to webhook URLs when explicitly instructed.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: webhookToolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const handler = handlers[name];
    if (!handler) throw new Error(`unknown tool: ${name}`);
    const result = await handler(args || {});
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createWebhookMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
