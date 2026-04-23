import { parseModelReference } from "../core/ai.js";
import { buildModelCapabilities, getModelByProviderAndName, getProvider } from "../core/providers.js";
import { readRunSection } from "../core/journal.js";
import { isValidSlug, uniqueSlug } from "../core/slugs.js";

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

function validateModelForAgent({ db, dataDir, model }) {
  const resolved = parseModelReference(model);
  if (resolved.sdk !== "vercel") return resolved;

  const provider = getProvider({ db, dataDir, id: resolved.providerId, includeKey: false });
  if (!provider) throw new Error(`provider not found: ${resolved.providerId}`);
  if (!provider.enabled) throw new Error(`provider disabled: ${provider.name}`);

  const modelRow = getModelByProviderAndName({ db, providerId: resolved.providerId, modelName: resolved.modelName });
  if (!modelRow) return resolved;
  if (!modelRow.enabled) throw new Error(`model disabled: ${resolved.modelName}`);

  const capabilities = buildModelCapabilities(provider.provider_type, modelRow.model_name, modelRow.capabilities);
  if (!capabilities.runnable_for_agent) {
    throw new Error(`model is not runnable for agents: ${capabilities.unavailable_reason}`);
  }
  return resolved;
}

export function registerAgentRoutes(app, { db, broker, consolidation, dataDir }) {
  app.get("/api/agents", (_req, res) => {
    const rows = db.prepare("SELECT * FROM agents ORDER BY name").all();
    res.json({ agents: rows.map(rowToAgent) });
  });

  app.post("/api/agents", (req, res) => {
    const { name, display_name, model } = req.body || {};

    if (!display_name || !model) {
      return res.status(400).json({ error: { code: "validation", message: "display_name and explicit model reference required" } });
    }
    if (name && !isValidSlug(name)) {
      return res.status(400).json({ error: { code: "validation", message: "invalid name (lowercase slug required)" } });
    }
    const finalName = name || uniqueSlug(display_name, (candidate) =>
      Boolean(db.prepare("SELECT name FROM agents WHERE name = ?").get(candidate)),
      { fallback: "agent" },
    );
    let resolved;
    try {
      resolved = validateModelForAgent({ db, dataDir, model });
    } catch (err) {
      return res.status(400).json({ error: { code: "invalid_model", message: err.message } });
    }

    const existing = db.prepare("SELECT name FROM agents WHERE name = ?").get(finalName);
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
    `).run(finalName, display_name, description, resolved.sdk, model, effort, instructions,
           skillsAllow, mcpAllow, builtinAllow, enabled, now, now);

    broker.broadcast("global", { type: "agent_updated", name: finalName });
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(finalName);
    res.status(201).json({ agent: rowToAgent(row) });
  });

  app.get("/api/agents/:name", (req, res) => {
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(req.params.name);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    res.json({ agent: rowToAgent(row) });
  });

  app.post("/api/agents/:name/consolidate", (req, res) => {
    if (!consolidation) return res.status(501).json({ error: { code: "not_configured", message: "consolidation not wired" } });
    try {
      const result = consolidation.runNow(req.params.name, { force: true });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: { code: "consolidation_failed", message: err.message } });
    }
  });

  app.patch("/api/agents/:name", (req, res) => {
    const existing = db.prepare("SELECT * FROM agents WHERE name = ?").get(req.params.name);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });

    const fields = [];
    const values = [];

    for (const k of PATCHABLE) {
      if (k in req.body) {
        if (k === "model") {
          try {
            const resolved = validateModelForAgent({ db, dataDir, model: req.body[k] });
            fields.push("sdk = ?");
            values.push(resolved.sdk);
          } catch (err) {
            return res.status(400).json({ error: { code: "invalid_model", message: err.message } });
          }
        }
        if (k === "sdk") continue;
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

  // Recent runs (joined with task_runs, agent_logs, tasks) — powers the
  // "Recent runs" section on AgentEdit and the "N runs" pill on Agents.
  app.get("/api/agents/:name/runs", (req, res) => {
    const existing = db.prepare("SELECT name FROM agents WHERE name = ?").get(req.params.name);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const rows = db.prepare(`
      SELECT r.id, r.task_id, r.mode, r.status, r.started_at, r.ended_at,
             t.title AS task_title,
             l.model, l.cost_usd, l.duration_ms, l.input_tokens, l.output_tokens
      FROM task_runs r
      LEFT JOIN tasks t ON t.id = r.task_id
      LEFT JOIN agent_logs l ON l.task_run_id = r.id
      WHERE r.agent_name = ?
      ORDER BY r.started_at DESC
      LIMIT ?
    `).all(req.params.name, limit);
    res.json({ runs: rows });
  });

  // Run-scoped journal section — renders inline below the event timeline
  // in TaskDetail, closing the gap between "what the SDK did" (events) and
  // "what the agent decided" (journal).
  app.get("/api/agents/:name/journal", (req, res) => {
    const existing = db.prepare("SELECT name FROM agents WHERE name = ?").get(req.params.name);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    const runId = req.query.run;
    if (!runId) return res.status(400).json({ error: { code: "validation", message: "run query param required" } });
    const section = readRunSection({ dataDir, agent: req.params.name, runId: String(runId) });
    res.json({ section: section || null });
  });
}
