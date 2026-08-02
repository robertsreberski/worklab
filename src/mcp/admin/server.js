import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { adminToolDefinitions, createAdminToolHandlers } from "./tools/index.js";
import { ensureMcpToken, tokenMatches } from "../../core/index.js";

function bearer(req) {
  const value = req.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : "";
}

export function createAdminMcpServer(context) {
  const handlers = createAdminToolHandlers(context);
  const server = new Server(
    { name: "worklab-admin", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: "Full-access local Worklab administration MCP server.",
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

  return server;
}

export function registerAdminMcpRoutes(app, { config, logger }) {
  const expectedToken = ensureMcpToken(config.dataDir);

  app.use("/mcp", (req, res, next) => {
    if (!tokenMatches(bearer(req), expectedToken)) {
      return res.status(401).json({ error: { code: "unauthorized", message: "invalid MCP token" } });
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    const server = createAdminMcpServer({
      baseUrl: `http://${config.host}:${config.port}`,
      config,
      token: expectedToken,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (err) {
      logger?.error?.({ err }, "admin MCP request failed");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: err.message || "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });
}
