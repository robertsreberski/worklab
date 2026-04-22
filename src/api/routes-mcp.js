import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadMcpConfig } from "../core/mcp-config.js";

export function registerMcpRoutes(app, { dataDir }) {
  const mcpPath = () => join(dataDir, "config", "mcp.json");

  app.get("/api/mcp", (_req, res) => {
    const p = mcpPath();
    if (!existsSync(p)) return res.json({ mcpServers: {} });
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      res.json({ mcpServers: parsed.mcpServers || {} });
    } catch (err) {
      res.status(500).json({ error: { code: "parse_error", message: err.message } });
    }
  });

  app.put("/api/mcp", (req, res) => {
    const body = req.body || {};
    if (!body.mcpServers || typeof body.mcpServers !== "object") {
      return res.status(400).json({ error: { code: "validation", message: "mcpServers object required" } });
    }
    const p = mcpPath();
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    const prev = existsSync(p) ? readFileSync(p, "utf8") : null;
    writeFileSync(p, JSON.stringify({ mcpServers: body.mcpServers }, null, 2));
    try {
      loadMcpConfig(dataDir);
    } catch (err) {
      if (prev !== null) writeFileSync(p, prev);
      else { try { unlinkSync(p); } catch {} }
      return res.status(400).json({ error: { code: "validation", message: err.message } });
    }
    res.json({ mcpServers: body.mcpServers });
  });
}
