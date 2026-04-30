import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createToolHandlers, toolDefinitions } from "./tools.js";

const context = {
  dataDir: process.env.WORKLAB_DATA_DIR,
  agent: process.env.WORKLAB_AGENT_NAME,
  runId: process.env.WORKLAB_RUN_ID,
  taskId: process.env.WORKLAB_TASK_ID,
  taskTitle: process.env.WORKLAB_TASK_TITLE,
};

for (const [k, v] of Object.entries(context)) {
  if (!v) {
    console.error(`[worklab-mcp] missing env ${k}`);
    process.exit(1);
  }
}

const handlers = createToolHandlers(context);
const server = new Server({ name: "worklab", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = handlers[name];
  if (!handler) throw new Error(`unknown tool: ${name}`);
  const result = await handler(args || {});
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
