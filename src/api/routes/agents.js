import {
  buildModelCapabilities,
  getBuiltinModelByReference,
  getBuiltinProviderAvailability,
  getMcpServerStatuses,
  getModelByProviderAndName,
  getProvider,
  isValidSlug,
  loadSkills,
  listAgentMemories,
  normalizeModelReference,
  normalizeReasoningEffortForModel,
  readAgentMemoryState,
  readRunSection,
  updateAgentMemory,
  uniqueSlug,
} from "../../core/index.js";
import { executionModeIncompatibilityReason } from "@worklab/agent-runtime/ai/runtime/model-refs.js";
import {
  ALLOWLIST_MODE_ALL,
  inferAllowlistMode,
  normalizeAllowlistMode,
  normalizeList,
  parseStoredAllowlist,
  storedAllowlistMode,
} from "@worklab/agent-runtime/agent/allowlists.js";
import {
  agentExists,
  deleteAgentByName,
  getAgentByName,
  insertAgent,
  listAgentsWithRunStats,
  updateAgentFields,
} from "../../core/db/queries/agents.js";
import {
  agentHasRunningRun,
  listRecentAgentRuns,
} from "../../core/db/queries/runs.js";
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
    browser_tools_review_only: !!row.browser_tools_review_only,
    subagent_mode: normalizeSubagentMode(row.subagent_mode, "advisory"),
    execution_mode: row.execution_mode || "sdk",
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
  "browser_tools_review_only",
  "subagent_mode",
  "execution_mode",
  "enabled",
];

const VALID_EXECUTION_MODES = new Set(["sdk", "cli"]);
const VALID_SUBAGENT_MODES = new Set(["disabled", "advisory", "workspace"]);

function normalizeExecutionMode(value, fallback = "sdk") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new Error("execution_mode must be a string");
  const trimmed = value.trim();
  if (!VALID_EXECUTION_MODES.has(trimmed)) {
    throw new Error(`execution_mode must be one of: ${[...VALID_EXECUTION_MODES].join(", ")}`);
  }
  return trimmed;
}

function normalizeSubagentMode(value, fallback = "advisory") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new Error("subagent_mode must be a string");
  const trimmed = value.trim();
  if (!VALID_SUBAGENT_MODES.has(trimmed)) {
    throw new Error(`subagent_mode must be one of: ${[...VALID_SUBAGENT_MODES].join(", ")}`);
  }
  return trimmed;
}

function validateModelForAgent({ db, dataDir, model }) {
  const resolved = normalizeModelReference(model);
  const builtin = getBuiltinModelByReference(resolved.reference);
  if (builtin) {
    const availabilityKey = resolved.sdk === "pi" ? `pi:${resolved.provider}` : resolved.sdk;
    const availability = getBuiltinProviderAvailability({ dataDir })[availabilityKey];
    if (availability?.available === false) {
      throw new Error(`${availabilityKey} unavailable: ${availability.reason || "provider unavailable"}`);
    }
    return resolved;
  }

  if (resolved.sdk !== "pi") throw new Error(`unknown built-in model: ${resolved.reference}`);
  const provider = getProvider({ db, dataDir, id: resolved.provider, includeKey: false });
  if (!provider) throw new Error(`provider not found: ${resolved.provider}`);
  if (!provider.enabled) throw new Error(`provider disabled: ${provider.name}`);

  const modelRow = getModelByProviderAndName({ db, providerId: resolved.provider, modelName: resolved.model });
  if (!modelRow) return resolved;
  if (!modelRow.enabled) throw new Error(`model disabled: ${resolved.model}`);

  const capabilities = buildModelCapabilities(provider.provider_type, modelRow.model_name, modelRow.capabilities);
  if (!capabilities.runnable_for_agent) {
    throw new Error(`model is not runnable for agents: ${capabilities.unavailable_reason}`);
  }
  return resolved;
}

function capabilitiesForAgentModel({ db, dataDir, model, resolved }) {
  if (resolved?.capabilities) return resolved.capabilities;
  const ref = resolved?.reference || model;
  const builtin = getBuiltinModelByReference(ref);
  if (builtin) return builtin.capabilities || null;
  if (resolved?.sdk !== "pi") return null;

  const provider = getProvider({ db, dataDir, id: resolved.provider, includeKey: false });
  const modelRow = provider ? getModelByProviderAndName({ db, providerId: resolved.provider, modelName: resolved.model }) : null;
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
    const rows = listAgentsWithRunStats(db, since);
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
      agentExists(db, candidate),
      { fallback: "agent" },
    );
    let resolved;
    let canonicalModel;
    try {
      resolved = validateModelForAgent({ db, dataDir, model });
      canonicalModel = resolved.reference;
    } catch (err) {
      return res.status(400).json({ error: { code: "invalid_model", message: err.message } });
    }

    const existing = agentExists(db, finalName) ? { name: finalName } : null;
    if (existing) {
      return res.status(409).json({ error: { code: "conflict", message: "agent name already exists" } });
    }

    const now = Date.now();
    const effort = normalizeAgentEffort({ db, dataDir, model: canonicalModel, resolved, effort: req.body.effort || "medium" });
    const description = req.body.description || null;
    const instructions = req.body.instructions || "";
    let skillsAllow;
    let mcpAllow;
    let builtinAllow;
    try {
      skillsAllow = createAllowlist({ body: req.body, listKey: "skills_allowlist", dataDir, model: canonicalModel });
      mcpAllow = createAllowlist({ body: req.body, listKey: "mcp_allowlist", dataDir, model: canonicalModel });
      builtinAllow = createAllowlist({ body: req.body, listKey: "builtin_allowlist", dataDir, model: canonicalModel });
    } catch (err) {
      return res.status(400).json({ error: { code: "unavailable_selection", message: err.message } });
    }
    const enabled = req.body.enabled === false ? 0 : 1;
    let allowSelfReview;
    let browserToolsReviewOnly;
    let subagentMode;
    let executionMode;
    try {
      allowSelfReview = normalizeBooleanField("allow_self_review", req.body.allow_self_review, true);
      browserToolsReviewOnly = normalizeBooleanField("browser_tools_review_only", req.body.browser_tools_review_only, false);
      subagentMode = normalizeSubagentMode(req.body.subagent_mode, "advisory");
      executionMode = normalizeExecutionMode(req.body.execution_mode, "sdk");
    } catch (err) {
      return res.status(400).json({ error: { code: "validation", message: err.message } });
    }
    // Refuse model + execution_mode combos that cannot actually run. Codex
    // CLI is codex:<model>; pi:* providers, including openai-codex, are SDK.
    {
      const reason = executionModeIncompatibilityReason(resolved, executionMode);
      if (reason) {
        return res.status(400).json({
          error: {
            code: "incompatible_execution_mode",
            message: reason,
            execution_mode: executionMode,
            model: canonicalModel,
          },
        });
      }
    }

    insertAgent(db, {
      name: finalName,
      displayName: display_name,
      description,
      sdk: resolved.sdk,
      model: canonicalModel,
      effort,
      instructions,
      skillsAllowlistJson: JSON.stringify(skillsAllow.list),
      skillsAllowlistMode: skillsAllow.mode,
      mcpAllowlistJson: JSON.stringify(mcpAllow.list),
      mcpAllowlistMode: mcpAllow.mode,
      builtinAllowlistJson: JSON.stringify(builtinAllow.list),
      builtinAllowlistMode: builtinAllow.mode,
      allowSelfReview,
      browserToolsReviewOnly,
      subagentMode,
      executionMode,
      enabled,
      createdAt: now,
      updatedAt: now,
    });

    broker.broadcast("global", { type: "agent_updated", name: finalName });
    const row = getAgentByName(db, finalName);
    res.status(201).json({ agent: rowToAgent(row) });
  });

  app.get("/api/agents/:name", (req, res) => {
    const row = getAgentByName(db, req.params.name);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    res.json({ agent: rowToAgent(row) });
  });

  app.get("/api/agents/:name/memory", (req, res) => {
    if (!dataDir) return res.status(501).json({ error: { code: "not_configured", message: "data directory not configured" } });
    if (!agentExists(db, req.params.name)) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    const memory = readAgentMemoryState({
      db,
      dataDir,
      agent: req.params.name,
      consolidating: Boolean(consolidation?.isActive?.(req.params.name)),
    });
    res.json({ memory });
  });

  app.get("/api/agents/:name/memories", (req, res) => {
    if (!agentExists(db, req.params.name)) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const memories = listAgentMemories(db, {
      agentName: req.params.name,
      status: req.query.status || null,
      kind: req.query.kind || null,
      limit,
    });
    res.json({ memories });
  });

  app.patch("/api/agents/:name/memories/:memoryId", (req, res) => {
    if (!agentExists(db, req.params.name)) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    const current = listAgentMemories(db, { agentName: req.params.name, limit: 200 })
      .find((memory) => memory.id === req.params.memoryId);
    if (!current) return res.status(404).json({ error: { code: "not_found", message: "memory not found" } });
    try {
      const memory = updateAgentMemory(db, req.params.memoryId, req.body || {});
      broker.broadcast("global", { type: "agent_memory_updated", name: req.params.name, memory_id: req.params.memoryId });
      res.json({ memory });
    } catch (err) {
      res.status(400).json({ error: { code: "validation", message: err.message } });
    }
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
    const existing = getAgentByName(db, req.params.name);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });

    const fields = [];
    const values = [];
    let targetModel = existing.model;
    let targetResolved = null;
    let wroteEffort = false;

    for (const k of PATCHABLE) {
      if (k in req.body) {
        if (ALLOWLIST_PATCH_KEYS.has(k)) continue;
        if (k === "model") {
          try {
            const resolved = req.body[k] === existing.model
              ? normalizeModelReference(req.body[k])
              : validateModelForAgent({ db, dataDir, model: req.body[k] });
            targetResolved = resolved;
            targetModel = resolved.reference;
            fields.push("sdk = ?");
            values.push(resolved.sdk);
          } catch (err) {
            return res.status(400).json({ error: { code: "invalid_model", message: err.message } });
          }
        }
        if (k === "sdk") continue;
        if (k === "effort") {
          try {
            targetResolved ||= normalizeModelReference(targetModel);
            targetModel = targetResolved.reference;
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
        } else if (k === "allow_self_review" || k === "browser_tools_review_only") {
          try {
            values.push(normalizeBooleanField(k, req.body[k], false));
          } catch (err) {
            return res.status(400).json({ error: { code: "validation", message: err.message } });
          }
        } else if (k === "execution_mode") {
          try {
            values.push(normalizeExecutionMode(req.body[k], existing.execution_mode || "sdk"));
          } catch (err) {
            return res.status(400).json({ error: { code: "validation", message: err.message } });
          }
        } else if (k === "subagent_mode") {
          try {
            values.push(normalizeSubagentMode(req.body[k], existing.subagent_mode || "advisory"));
          } catch (err) {
            return res.status(400).json({ error: { code: "validation", message: err.message } });
          }
        } else {
          values.push(k === "model" ? targetModel : req.body[k]);
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
      targetResolved ||= normalizeModelReference(targetModel);
      targetModel = targetResolved.reference;
      fields.push("effort = ?");
      values.push(normalizeAgentEffort({ db, dataDir, model: targetModel, resolved: targetResolved, effort: existing.effort || "medium" }));
    }

    // Refuse model + execution_mode combos that cannot actually run. Run after
    // the per-field loop so we check the values that will actually be
    // persisted (mix of patch + existing).
    {
      const effectiveExecutionMode = "execution_mode" in req.body
        ? normalizeExecutionMode(req.body.execution_mode, existing.execution_mode || "sdk")
        : (existing.execution_mode || "sdk");
      const effectiveModel = "model" in req.body ? targetModel : existing.model;
      let effectiveResolved = targetResolved;
      if (!effectiveResolved && effectiveModel) {
        try { effectiveResolved = normalizeModelReference(effectiveModel); } catch { effectiveResolved = null; }
      }
      const reason = effectiveResolved
        ? executionModeIncompatibilityReason(effectiveResolved, effectiveExecutionMode)
        : null;
      if (reason) {
        return res.status(400).json({
          error: {
            code: "incompatible_execution_mode",
            message: reason,
            execution_mode: effectiveExecutionMode,
            model: effectiveModel,
          },
        });
      }
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(Date.now());
      values.push(req.params.name);
      updateAgentFields(db, fields, values);
    }

    broker.broadcast("global", { type: "agent_updated", name: req.params.name });
    const row = getAgentByName(db, req.params.name);
    res.json({ agent: rowToAgent(row) });
  });

  app.delete("/api/agents/:name", (req, res) => {
    if (agentHasRunningRun(db, req.params.name) || consolidation?.isActive?.(req.params.name)) {
      return res.status(409).json({ error: { code: "agent_running", message: "wait for active runs to finish before deleting this agent" } });
    }
    const r = deleteAgentByName(db, req.params.name);
    if (r.changes === 0) {
      return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    }
    broker.broadcast("global", { type: "agent_deleted", name: req.params.name });
    res.status(204).end();
  });

  // Recent runs (joined with task_runs, agent_logs, tasks) — powers the
  // "Recent runs" section on AgentEdit and the "N runs" pill on Agents.
  app.get("/api/agents/:name/runs", (req, res) => {
    if (!agentExists(db, req.params.name)) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    res.json({ runs: listRecentAgentRuns(db, req.params.name, limit) });
  });

  // Run-scoped journal section — renders inline below the event timeline
  // in TaskDetail, closing the gap between "what the SDK did" (events) and
  // "what the agent decided" (journal).
  app.get("/api/agents/:name/journal", (req, res) => {
    if (!agentExists(db, req.params.name)) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    const runId = req.query.run;
    if (!runId) return res.status(400).json({ error: { code: "validation", message: "run query param required" } });
    const section = readRunSection({ dataDir, agent: req.params.name, runId: String(runId) });
    res.json({ section: section || null });
  });
}
