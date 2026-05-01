import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getMcpServerHealth, getMcpServerStatuses, loadMcpConfig } from "../../core/index.js";

export function registerMcpRoutes(app, { dataDir, repoRoot = process.cwd(), workspace = process.cwd() }) {
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

  app.get("/api/mcp/status", (_req, res) => {
    const status = getMcpServerStatuses(dataDir, { repoRoot });
    res.json(status);
  });

  app.post("/api/mcp/health", async (req, res, next) => {
    const body = req.body || {};
    const hasDraftServers = Object.prototype.hasOwnProperty.call(body, "mcpServers");
    if (hasDraftServers && (!body.mcpServers || typeof body.mcpServers !== "object" || Array.isArray(body.mcpServers))) {
      return res.status(400).json({ error: { code: "validation", message: "mcpServers object required" } });
    }
    if (body.names != null && !Array.isArray(body.names)) {
      return res.status(400).json({ error: { code: "validation", message: "names must be an array" } });
    }
    try {
      const health = await getMcpServerHealth(dataDir, {
        repoRoot,
        cwd: workspace,
        includeBuiltins: body.includeBuiltins !== false,
        mcpServers: hasDraftServers ? body.mcpServers : undefined,
        names: body.names,
      });
      return res.json(health);
    } catch (err) {
      return next(err);
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
