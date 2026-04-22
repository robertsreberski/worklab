const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function rowToAgent(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
    skills_allowlist: JSON.parse(row.skills_allowlist || "[]"),
    mcp_allowlist: JSON.parse(row.mcp_allowlist || "[]"),
    builtin_allowlist: JSON.parse(row.builtin_allowlist || "[]"),
  };
}

const PATCHABLE = [
  "display_name",
  "description",
  "sdk",
  "model",
  "effort",
  "instructions",
  "skills_allowlist",
  "mcp_allowlist",
  "builtin_allowlist",
  "enabled",
];

export function registerAgentRoutes(app, { db, broker }) {
  app.get("/api/agents", (_req, res) => {
    const rows = db.prepare("SELECT * FROM agents ORDER BY name").all();
    res.json({ agents: rows.map(rowToAgent) });
  });

  app.post("/api/agents", (req, res) => {
    const { name, display_name, sdk, model } = req.body || {};

    if (!name || !NAME_RE.test(name)) {
      return res.status(400).json({ error: { code: "validation", message: "invalid name (lowercase slug required)" } });
    }
    if (!display_name || !sdk || !model) {
      return res.status(400).json({ error: { code: "validation", message: "display_name, sdk, model required" } });
    }

    const existing = db.prepare("SELECT name FROM agents WHERE name = ?").get(name);
    if (existing) {
      return res.status(409).json({ error: { code: "conflict", message: "agent name already exists" } });
    }

    const now = Date.now();
    const effort = req.body.effort || "medium";
    const description = req.body.description || null;
    const instructions = req.body.instructions || "";
    const skillsAllow = JSON.stringify(req.body.skills_allowlist || []);
    const mcpAllow = JSON.stringify(req.body.mcp_allowlist || []);
    const builtinAllow = JSON.stringify(req.body.builtin_allowlist || []);
    const enabled = req.body.enabled === false ? 0 : 1;

    db.prepare(`
      INSERT INTO agents
        (name, display_name, description, sdk, model, effort, instructions,
         skills_allowlist, mcp_allowlist, builtin_allowlist, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, display_name, description, sdk, model, effort, instructions,
           skillsAllow, mcpAllow, builtinAllow, enabled, now, now);

    broker.broadcast("global", { type: "agent_updated", name });
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(name);
    res.status(201).json({ agent: rowToAgent(row) });
  });

  app.get("/api/agents/:name", (req, res) => {
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(req.params.name);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    res.json({ agent: rowToAgent(row) });
  });

  app.patch("/api/agents/:name", (req, res) => {
    const existing = db.prepare("SELECT * FROM agents WHERE name = ?").get(req.params.name);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });

    const fields = [];
    const values = [];

    for (const k of PATCHABLE) {
      if (k in req.body) {
        fields.push(`${k} = ?`);
        if (k.endsWith("_allowlist")) {
          values.push(JSON.stringify(req.body[k] ?? []));
        } else if (k === "enabled") {
          values.push(req.body[k] ? 1 : 0);
        } else {
          values.push(req.body[k]);
        }
      }
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(Date.now());
      values.push(req.params.name);
      db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE name = ?`).run(...values);
    }

    broker.broadcast("global", { type: "agent_updated", name: req.params.name });
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(req.params.name);
    res.json({ agent: rowToAgent(row) });
  });

  app.delete("/api/agents/:name", (req, res) => {
    const r = db.prepare("DELETE FROM agents WHERE name = ?").run(req.params.name);
    if (r.changes === 0) {
      return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    }
    broker.broadcast("global", { type: "agent_deleted", name: req.params.name });
    res.status(204).end();
  });
}
