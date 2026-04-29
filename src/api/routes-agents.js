import { getBuiltinModelByReference, normalizeReasoningEffortForModel, parseModelReference } from "../core/ai.js";
import { buildModelCapabilities, getModelByProviderAndName, getProvider } from "../core/providers.js";
import { readRunSection } from "../core/journal.js";
import { isValidSlug, uniqueSlug } from "../core/slugs.js";
import { getBuiltinProviderAvailability } from "../core/credentials.js";
import { loadSkills } from "../core/skills.js";
import { getMcpServerStatuses } from "../core/mcp-config.js";
import { readAgentMemoryState } from "../core/memory.js";
import {
  ALLOWLIST_MODE_ALL,
  inferAllowlistMode,
  normalizeAllowlistMode,
  normalizeList,
  parseStoredAllowlist,
  storedAllowlistMode,
} from "../core/agent-allowlists.js";
import { join } from "node:path";

function rowToAgent(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
    skills_allowlist: parseStoredAllowlist(row.skills_allowlist),
    skills_allowlist_mode: storedAllowlistMode(row.skills_allowlist_mode),
    mcp_allowlist: parseStoredAllowlist(row.mcp_allowlist),
    mcp_allowlist_mode: storedAllowlistMode(row.mcp_allowlist_mode),
    builtin_allowlist: parseStoredAllowlist(row.builtin_allowlist),
    builtin_allowlist_mode: storedAllowlistMode(row.builtin_allowlist_mode),
    allow_self_review: !!row.allow_self_review,
    daily_budget_usd: row.daily_budget_usd == null ? null : Number(row.daily_budget_usd),
    per_run_budget_usd: row.per_run_budget_usd == null ? null : Number(row.per_run_budget_usd),
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
  "skills_allowlist_mode",
  "mcp_allowlist",
  "mcp_allowlist_mode",
  "builtin_allowlist",
  "builtin_allowlist_mode",
  "allow_self_review",
  "daily_budget_usd",
  "per_run_budget_usd",
  "enabled",
];

function validateModelForAgent({ db, dataDir, model }) {
  const resolved = parseModelReference(model);
  if (resolved.sdk !== "vercel") {
    const builtin = getBuiltinModelByReference(resolved.reference);
    if (!builtin) throw new Error(`unknown built-in model: ${resolved.reference}`);
    const availability = getBuiltinProviderAvailability()[resolved.sdk];
    if (availability?.available === false) {
      throw new Error(`${resolved.sdk} unavailable: ${availability.reason || "provider unavailable"}`);
    }
    return resolved;
  }

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

function capabilitiesForAgentModel({ db, dataDir, model, resolved }) {
  if (resolved?.capabilities) return resolved.capabilities;
  const ref = resolved?.reference || model;
  if (resolved?.sdk !== "vercel") return getBuiltinModelByReference(ref)?.capabilities || null;

  const provider = getProvider({ db, dataDir, id: resolved.providerId, includeKey: false });
  const modelRow = provider ? getModelByProviderAndName({ db, providerId: resolved.providerId, modelName: resolved.modelName }) : null;
  return provider && modelRow
    ? buildModelCapabilities(provider.provider_type, modelRow.model_name, modelRow.capabilities)
    : null;
}

function normalizeAgentEffort({ db, dataDir, model, resolved, effort }) {
  return normalizeReasoningEffortForModel(
    resolved || model,
    effort,
    capabilitiesForAgentModel({ db, dataDir, model, resolved }),
  );
}

function sameList(left, right) {
  return JSON.stringify(normalizeList(left)) === JSON.stringify(normalizeList(right));
}

function normalizeBooleanField(key, value, fallback = false) {
  if (value === undefined) return fallback ? 1 : 0;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value ? 1 : 0;
}

function normalizeBudgetField(key, value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return n;
}

function existingAllowlist(row, key) {
  return parseStoredAllowlist(row?.[key]);
}

function validateSkillAllowlist({ dataDir, allowlist }) {
  const list = normalizeList(allowlist);
  if (!list.length || !dataDir) return list;
  const skills = loadSkills(join(dataDir, "skills"));
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  for (const name of list) {
    const skill = byName.get(name);
    if (!skill) throw new Error(`skill not found: ${name}`);
    if (skill.enabled === false) throw new Error(`skill disabled: ${name}`);
  }
  return list;
}

function validateMcpAllowlist({ dataDir, allowlist }) {
  const list = normalizeList(allowlist);
  if (!list.length || !dataDir) return list;
  const status = getMcpServerStatuses(dataDir);
  const byName = new Map((status.servers || []).map((server) => [server.name, server]));
  for (const name of list) {
    const server = byName.get(name);
    if (!server) throw new Error(`MCP server not found: ${name}`);
    if (server.available === false) {
      throw new Error(`MCP server unavailable: ${name}${server.unavailable_reason ? ` (${server.unavailable_reason})` : ""}`);
    }
  }
  return list;
}

function validateBuiltinAllowlist({ model, allowlist }) {
  const list = normalizeList(allowlist);
  if (!list.length) return list;
  const builtin = getBuiltinModelByReference(model);
  if (!builtin) return list;
  const supported = new Set(builtin.builtin_tools || []);
  for (const name of list) {
    if (!supported.has(name)) throw new Error(`built-in tool unavailable for ${model}: ${name}`);
  }
  return list;
}

const ALLOWLIST_FIELDS = {
  skills_allowlist: { modeKey: "skills_allowlist_mode", validate: validateSkillAllowlist },
  mcp_allowlist: { modeKey: "mcp_allowlist_mode", validate: validateMcpAllowlist },
  builtin_allowlist: { modeKey: "builtin_allowlist_mode", validate: validateBuiltinAllowlist },
};
const ALLOWLIST_PATCH_KEYS = new Set(Object.entries(ALLOWLIST_FIELDS).flatMap(([listKey, { modeKey }]) => [listKey, modeKey]));

function existingAllowlistMode(row, listKey) {
  return storedAllowlistMode(row?.[ALLOWLIST_FIELDS[listKey]?.modeKey]);
}

function validateAllowlist({ listKey, mode, list, dataDir, model }) {
  if (mode === ALLOWLIST_MODE_ALL) return [];
  const { validate } = ALLOWLIST_FIELDS[listKey];
  if (listKey === "builtin_allowlist") return validate({ model, allowlist: list });
  return validate({ dataDir, allowlist: list });
}

function createAllowlist({ body, listKey, dataDir, model }) {
  const { modeKey } = ALLOWLIST_FIELDS[listKey];
  const rawList = body?.[listKey] ?? [];
  const mode = inferAllowlistMode({
    mode: body && modeKey in body ? body[modeKey] : undefined,
    list: rawList,
    fallback: ALLOWLIST_MODE_ALL,
  });
  return {
    mode,
    list: validateAllowlist({ listKey, mode, list: rawList, dataDir, model }),
  };
}

function patchAllowlist({ body, existing, listKey, dataDir, model }) {
  const { modeKey } = ALLOWLIST_FIELDS[listKey];
  const hasList = listKey in body;
  const hasMode = modeKey in body;
  if (!hasList && !hasMode) return null;

  const existingList = existingAllowlist(existing, listKey);
  const existingMode = existingAllowlistMode(existing, listKey);
  const rawList = hasList ? body[listKey] : existingList;
  const mode = hasMode
    ? normalizeAllowlistMode(body[modeKey])
    : inferAllowlistMode({ list: rawList, fallback: existingMode });
  const normalizedList = normalizeList(rawList);
  const changed = mode !== existingMode || !sameList(normalizedList, existingList);
  return {
    mode,
    list: changed
      ? validateAllowlist({ listKey, mode, list: normalizedList, dataDir, model })
      : (mode === ALLOWLIST_MODE_ALL ? [] : normalizedList),
  };
}

export function registerAgentRoutes(app, { db, broker, consolidation, dataDir }) {
  app.get("/api/agents", (_req, res) => {
    const since = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const rows = db.prepare(`
      SELECT
        a.*,
        MAX(r.started_at) AS last_run_at,
        COUNT(CASE WHEN r.started_at >= ? THEN 1 END) AS run_count_30d,
        AVG(CASE WHEN r.started_at >= ? THEN l.duration_ms END) AS avg_run_duration_ms
      FROM agents a
      LEFT JOIN task_runs r ON r.agent_name = a.name
      LEFT JOIN agent_logs l ON l.task_run_id = r.id
      GROUP BY a.name
      ORDER BY a.name
    `).all(since, since);
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
    const effort = normalizeAgentEffort({ db, dataDir, model, resolved, effort: req.body.effort || "medium" });
    const description = req.body.description || null;
    const instructions = req.body.instructions || "";
    let skillsAllow;
    let mcpAllow;
    let builtinAllow;
    try {
      skillsAllow = createAllowlist({ body: req.body, listKey: "skills_allowlist", dataDir, model });
      mcpAllow = createAllowlist({ body: req.body, listKey: "mcp_allowlist", dataDir, model });
      builtinAllow = createAllowlist({ body: req.body, listKey: "builtin_allowlist", dataDir, model });
    } catch (err) {
      return res.status(400).json({ error: { code: "unavailable_selection", message: err.message } });
    }
    const enabled = req.body.enabled === false ? 0 : 1;
    let allowSelfReview;
    let dailyBudgetUsd;
    let perRunBudgetUsd;
    try {
      allowSelfReview = normalizeBooleanField("allow_self_review", req.body.allow_self_review, true);
      dailyBudgetUsd = normalizeBudgetField("daily_budget_usd", req.body.daily_budget_usd);
      perRunBudgetUsd = normalizeBudgetField("per_run_budget_usd", req.body.per_run_budget_usd);
    } catch (err) {
      return res.status(400).json({ error: { code: "validation", message: err.message } });
    }

    db.prepare(`
      INSERT INTO agents
        (name, display_name, description, sdk, model, effort, instructions,
         skills_allowlist, skills_allowlist_mode, mcp_allowlist, mcp_allowlist_mode,
         builtin_allowlist, builtin_allowlist_mode, allow_self_review,
         daily_budget_usd, per_run_budget_usd, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(finalName, display_name, description, resolved.sdk, model, effort, instructions,
           JSON.stringify(skillsAllow.list), skillsAllow.mode,
           JSON.stringify(mcpAllow.list), mcpAllow.mode,
           JSON.stringify(builtinAllow.list), builtinAllow.mode,
           allowSelfReview, dailyBudgetUsd, perRunBudgetUsd, enabled, now, now);

    broker.broadcast("global", { type: "agent_updated", name: finalName });
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(finalName);
    res.status(201).json({ agent: rowToAgent(row) });
  });

  app.get("/api/agents/:name", (req, res) => {
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(req.params.name);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    res.json({ agent: rowToAgent(row) });
  });

  app.get("/api/agents/:name/memory", (req, res) => {
    if (!dataDir) return res.status(501).json({ error: { code: "not_configured", message: "data directory not configured" } });
    const row = db.prepare("SELECT name FROM agents WHERE name = ?").get(req.params.name);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    const memory = readAgentMemoryState({
      db,
      dataDir,
      agent: req.params.name,
      consolidating: Boolean(consolidation?.isActive?.(req.params.name)),
    });
    res.json({ memory });
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
    const targetModel = req.body.model || existing.model;
    let targetResolved = null;
    let wroteEffort = false;

    for (const k of PATCHABLE) {
      if (k in req.body) {
        if (ALLOWLIST_PATCH_KEYS.has(k)) continue;
        if (k === "model") {
          try {
            const resolved = req.body[k] === existing.model
              ? parseModelReference(req.body[k])
              : validateModelForAgent({ db, dataDir, model: req.body[k] });
            targetResolved = resolved;
            fields.push("sdk = ?");
            values.push(resolved.sdk);
          } catch (err) {
            return res.status(400).json({ error: { code: "invalid_model", message: err.message } });
          }
        }
        if (k === "sdk") continue;
        if (k === "effort") {
          try {
            targetResolved ||= parseModelReference(targetModel);
            req.body[k] = normalizeAgentEffort({ db, dataDir, model: targetModel, resolved: targetResolved, effort: req.body[k] });
            wroteEffort = true;
          } catch (err) {
            return res.status(400).json({ error: { code: "invalid_model", message: err.message } });
          }
        }
        fields.push(`${k} = ?`);
        if (k.endsWith("_allowlist")) {
          values.push(JSON.stringify(req.body[k] ?? []));
        } else if (k === "enabled") {
          values.push(req.body[k] ? 1 : 0);
        } else if (k === "allow_self_review") {
          try {
            values.push(normalizeBooleanField(k, req.body[k], false));
          } catch (err) {
            return res.status(400).json({ error: { code: "validation", message: err.message } });
          }
        } else if (k === "daily_budget_usd" || k === "per_run_budget_usd") {
          try {
            values.push(normalizeBudgetField(k, req.body[k]));
          } catch (err) {
            return res.status(400).json({ error: { code: "validation", message: err.message } });
          }
        } else {
          values.push(req.body[k]);
        }
      }
    }

    for (const listKey of Object.keys(ALLOWLIST_FIELDS)) {
      let update;
      try {
        update = patchAllowlist({ body: req.body, existing, listKey, dataDir, model: targetModel });
      } catch (err) {
        return res.status(400).json({ error: { code: "unavailable_selection", message: err.message } });
      }
      if (!update) continue;
      const { modeKey } = ALLOWLIST_FIELDS[listKey];
      fields.push(`${listKey} = ?`, `${modeKey} = ?`);
      values.push(JSON.stringify(update.list), update.mode);
    }

    if ("model" in req.body && !wroteEffort) {
      targetResolved ||= parseModelReference(targetModel);
      fields.push("effort = ?");
      values.push(normalizeAgentEffort({ db, dataDir, model: targetModel, resolved: targetResolved, effort: existing.effort || "medium" }));
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
    const running = db.prepare(
      `SELECT id FROM task_runs
       WHERE agent_name = ? AND status = 'running'
       LIMIT 1`,
    ).get(req.params.name);
    if (running || consolidation?.isActive?.(req.params.name)) {
      return res.status(409).json({ error: { code: "agent_running", message: "wait for active runs to finish before deleting this agent" } });
    }
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
             t.task_key AS task_key,
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
