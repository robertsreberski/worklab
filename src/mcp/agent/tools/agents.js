// Agent-management tool exposed inside an agent run. Today this is a single
// tool (`agent_create`) — separate file so future agent-mutation tools have
// an obvious home and the surface stays grouped by domain.

import { z } from "zod";
import { withDb } from "./shared.js";
import { agentExists, getAgentByName } from "../../../core/db/queries/agents.js";
import {
  getBuiltinModelByReference,
  getModelByProviderAndName,
  getProvider,
  isValidSlug,
  normalizeReasoningEffortForModel,
  parseModelReference,
  uniqueSlug,
  WORKLAB_BUILTIN_TOOLS,
} from "../../../core/index.js";

const allowlistModeSchema = z.enum(["all", "custom"]).optional();
const effortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional();

export const agentCreateSchema = z.object({
  name: z.string().optional(),
  display_name: z.string().min(1, "display_name is required"),
  model: z.string().min(1, "model is required"),
  effort: effortSchema,
  description: z.string().optional(),
  instructions: z.string().optional(),
  skills_allowlist: z.array(z.string()).optional(),
  skills_allowlist_mode: allowlistModeSchema,
  mcp_allowlist: z.array(z.string()).optional(),
  mcp_allowlist_mode: allowlistModeSchema,
  builtin_allowlist: z.array(z.string()).optional(),
  builtin_allowlist_mode: allowlistModeSchema,
  allow_self_review: z.boolean().optional(),
  daily_budget_usd: z.number().nonnegative().nullable().optional(),
  per_run_budget_usd: z.number().nonnegative().nullable().optional(),
  enabled: z.boolean().optional(),
});

function normalizeList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function allowlistFor(input, listKey, modeKey) {
  const list = normalizeList(input[listKey]);
  const mode = input[modeKey] || (list.length ? "custom" : "all");
  return {
    mode,
    list: mode === "all" ? [] : list,
  };
}

function validateAgentModel({ db, dataDir, model }) {
  const resolved = parseModelReference(model);
  if (resolved.sdk !== "vercel") {
    if (!getBuiltinModelByReference(model)) throw new Error(`unknown built-in model: ${model}`);
    return resolved;
  }
  const provider = getProvider({ db, dataDir, id: resolved.providerId, includeKey: false });
  if (!provider) throw new Error(`provider not found: ${resolved.providerId}`);
  if (!provider.enabled) throw new Error(`provider disabled: ${provider.name}`);
  const modelRow = getModelByProviderAndName({ db, providerId: resolved.providerId, modelName: resolved.modelName });
  if (modelRow && !modelRow.enabled) throw new Error(`model disabled: ${resolved.modelName}`);
  return resolved;
}

function validateBuiltinAllowlist(model, allowlist) {
  const list = normalizeList(allowlist);
  const builtin = getBuiltinModelByReference(model);
  if (!builtin) return list;
  const supported = new Set(builtin.builtin_tools || WORKLAB_BUILTIN_TOOLS);
  for (const name of list) {
    if (!supported.has(name)) throw new Error(`built-in tool unavailable for ${model}: ${name}`);
  }
  return list;
}

function agentSummary(row) {
  return {
    name: row.name,
    display_name: row.display_name,
    model: row.model,
    sdk: row.sdk,
    effort: row.effort,
    enabled: !!row.enabled,
    skills_allowlist_mode: row.skills_allowlist_mode,
    mcp_allowlist_mode: row.mcp_allowlist_mode,
    builtin_allowlist_mode: row.builtin_allowlist_mode,
  };
}

export const definitions = [
  {
    name: "agent_create",
    description:
      "Create a Worklab agent from inside a run. Use explicit model references such as codex:gpt-5.5, claude:claude-sonnet-4-6, or vercel:<providerId>:<modelName>.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional lowercase slug. If omitted, Worklab derives one from display_name." },
        display_name: { type: "string", description: "Agent display name" },
        model: { type: "string", description: "Explicit model reference" },
        effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"] },
        description: { type: "string" },
        instructions: { type: "string" },
        skills_allowlist: { type: "array", items: { type: "string" } },
        skills_allowlist_mode: { type: "string", enum: ["all", "custom"] },
        mcp_allowlist: { type: "array", items: { type: "string" } },
        mcp_allowlist_mode: { type: "string", enum: ["all", "custom"] },
        builtin_allowlist: { type: "array", items: { type: "string" } },
        builtin_allowlist_mode: { type: "string", enum: ["all", "custom"] },
        allow_self_review: { type: "boolean" },
        daily_budget_usd: { type: "number", minimum: 0 },
        per_run_budget_usd: { type: "number", minimum: 0 },
        enabled: { type: "boolean" },
      },
      required: ["display_name", "model"],
    },
  },
];

export function buildHandlers(context) {
  const { dataDir } = context;
  return {
    async agent_create(input) {
      const parsed = agentCreateSchema.parse(input);
      return await withDb(dataDir, (db) => {
        const resolved = validateAgentModel({ db, dataDir, model: parsed.model });
        const finalName = parsed.name || uniqueSlug(parsed.display_name, (candidate) =>
          agentExists(db, candidate),
          { fallback: "agent" },
        );
        if (!isValidSlug(finalName)) throw new Error("invalid name (lowercase slug required)");
        if (agentExists(db, finalName)) {
          throw new Error(`agent already exists: ${finalName}`);
        }
        const skillsAllow = allowlistFor(parsed, "skills_allowlist", "skills_allowlist_mode");
        const mcpAllow = allowlistFor(parsed, "mcp_allowlist", "mcp_allowlist_mode");
        const builtinAllow = allowlistFor(parsed, "builtin_allowlist", "builtin_allowlist_mode");
        builtinAllow.list = validateBuiltinAllowlist(parsed.model, builtinAllow.list);
        const now = Date.now();
        const effort = normalizeReasoningEffortForModel(resolved, parsed.effort || "medium");
        db.prepare(`
          INSERT INTO agents
            (name, display_name, description, sdk, model, effort, instructions,
             skills_allowlist, skills_allowlist_mode, mcp_allowlist, mcp_allowlist_mode,
             builtin_allowlist, builtin_allowlist_mode, allow_self_review,
             daily_budget_usd, per_run_budget_usd, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          finalName,
          parsed.display_name,
          parsed.description || null,
          resolved.sdk,
          parsed.model,
          effort,
          parsed.instructions || "",
          JSON.stringify(skillsAllow.list),
          skillsAllow.mode,
          JSON.stringify(mcpAllow.list),
          mcpAllow.mode,
          JSON.stringify(builtinAllow.list),
          builtinAllow.mode,
          parsed.allow_self_review === false ? 0 : 1,
          parsed.daily_budget_usd ?? null,
          parsed.per_run_budget_usd ?? null,
          parsed.enabled === false ? 0 : 1,
          now,
          now,
        );
        return { agent: agentSummary(getAgentByName(db, finalName)) };
      });
    },
  };
}
