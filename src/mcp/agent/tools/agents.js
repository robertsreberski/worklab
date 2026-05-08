// Agent-management tool exposed inside an agent run. Today this is a single
// tool (`agent_create`) — separate file so future agent-mutation tools have
// an obvious home and the surface stays grouped by domain.

import { z } from "zod";
import { withDb } from "./shared.js";
import { agentExists, getAgentByName } from "../../../core/db/queries/agents.js";
import {
  buildModelCapabilities,
  getBuiltinModelByReference,
  getModelByProviderAndName,
  getProvider,
  isValidSlug,
  normalizeModelReference,
  normalizeReasoningEffortForModel,
  uniqueSlug,
  WORKLAB_BUILTIN_TOOLS,
} from "../../../core/index.js";
import { executionModeIncompatibilityReason } from "@worklab/agent-runtime/ai/runtime/model-refs.js";
import {
  claudeModelSupportsOneMillionContext,
  normalizeContextWindow,
  ONE_MILLION_CONTEXT_WINDOW,
} from "@worklab/agent-runtime/ai/runtime/context-windows.js";

const allowlistModeSchema = z.enum(["all", "custom"]).optional();
const effortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional();
const executionModeSchema = z.enum(["cli", "sdk"]).optional();
const subagentModeSchema = z.enum(["disabled", "advisory", "workspace"]).optional();
const contextWindowSchema = z.enum(["default", "1m"]).optional();

export const agentCreateSchema = z.object({
  name: z.string().optional(),
  display_name: z.string().min(1, "display_name is required"),
  model: z.string().min(1, "model is required"),
  execution_mode: executionModeSchema,
  effort: effortSchema,
  context_window: contextWindowSchema,
  description: z.string().optional(),
  instructions: z.string().optional(),
  skills_allowlist: z.array(z.string()).optional(),
  skills_allowlist_mode: allowlistModeSchema,
  mcp_allowlist: z.array(z.string()).optional(),
  mcp_allowlist_mode: allowlistModeSchema,
  builtin_allowlist: z.array(z.string()).optional(),
  builtin_allowlist_mode: allowlistModeSchema,
  allow_self_review: z.boolean().optional(),
  browser_tools_review_only: z.boolean().optional(),
  subagent_mode: subagentModeSchema,
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
  const resolved = normalizeModelReference(model);
  const reference = resolved.reference;
  if (getBuiltinModelByReference(reference)) {
    return resolved;
  }

  if (resolved.sdk !== "pi") throw new Error(`unknown built-in model: ${reference}`);
  const provider = getProvider({ db, dataDir, id: resolved.provider, includeKey: false });
  if (!provider) throw new Error(`provider not found: ${resolved.provider}`);
  if (!provider.enabled) throw new Error(`provider disabled: ${provider.name}`);
  const modelRow = getModelByProviderAndName({ db, providerId: resolved.provider, modelName: resolved.model });
  if (!modelRow) return resolved;
  if (modelRow && !modelRow.enabled) throw new Error(`model disabled: ${resolved.model}`);

  const capabilities = buildModelCapabilities(provider.provider_type, modelRow.model_name, modelRow.capabilities);
  if (!capabilities.runnable_for_agent) {
    throw new Error(`model is not runnable for agents: ${capabilities.unavailable_reason}`);
  }
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

function validateContextWindow({ resolved, contextWindow }) {
  const normalized = normalizeContextWindow(contextWindow);
  if (normalized !== ONE_MILLION_CONTEXT_WINDOW) return normalized;
  if (resolved.sdk === "claude" && claudeModelSupportsOneMillionContext(resolved.model)) {
    return normalized;
  }
  throw new Error("1M context is only available for Claude Opus 4.7 and Opus 4.6.");
}

function agentSummary(row) {
  return {
    name: row.name,
    display_name: row.display_name,
    model: row.model,
    sdk: row.sdk,
    effort: row.effort,
    context_window: row.context_window || "default",
    execution_mode: row.execution_mode || "sdk",
    enabled: !!row.enabled,
    skills_allowlist_mode: row.skills_allowlist_mode,
    mcp_allowlist_mode: row.mcp_allowlist_mode,
    builtin_allowlist_mode: row.builtin_allowlist_mode,
    browser_tools_review_only: !!row.browser_tools_review_only,
    subagent_mode: row.subagent_mode || "advisory",
  };
}

export const definitions = [
  {
    name: "agent_create",
    description:
      "Create a Worklab agent from inside a run. Use explicit model references such as codex:gpt-5.5, pi:openai-codex:gpt-5.5, claude:claude-sonnet-4-6, or pi:<providerId>:<modelName>. Set execution_mode=cli for codex:* models.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional lowercase slug. If omitted, Worklab derives one from display_name." },
        display_name: { type: "string", description: "Agent display name" },
        model: { type: "string", description: "Explicit model reference" },
        execution_mode: { type: "string", enum: ["cli", "sdk"], description: "Execution mode. codex:* requires cli; pi:* requires sdk." },
        effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"] },
        context_window: { type: "string", enum: ["default", "1m"], description: "1m is only available for Claude Opus 4.7 and Opus 4.6." },
        description: { type: "string" },
        instructions: { type: "string" },
        skills_allowlist: { type: "array", items: { type: "string" } },
        skills_allowlist_mode: { type: "string", enum: ["all", "custom"] },
        mcp_allowlist: { type: "array", items: { type: "string" } },
        mcp_allowlist_mode: { type: "string", enum: ["all", "custom"] },
        builtin_allowlist: { type: "array", items: { type: "string" } },
        builtin_allowlist_mode: { type: "string", enum: ["all", "custom"] },
        allow_self_review: { type: "boolean" },
        browser_tools_review_only: { type: "boolean" },
        subagent_mode: { type: "string", enum: ["disabled", "advisory", "workspace"] },
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
        const model = resolved.reference;
        const executionMode = parsed.execution_mode || "sdk";
        const modeReason = executionModeIncompatibilityReason(resolved, executionMode);
        if (modeReason) throw new Error(modeReason);
        const contextWindow = validateContextWindow({ resolved, contextWindow: parsed.context_window });
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
        builtinAllow.list = validateBuiltinAllowlist(model, builtinAllow.list);
        const now = Date.now();
        const effort = normalizeReasoningEffortForModel(resolved, parsed.effort || "medium");
        db.prepare(`
          INSERT INTO agents
            (name, display_name, description, sdk, model, effort, context_window, instructions,
             skills_allowlist, skills_allowlist_mode, mcp_allowlist, mcp_allowlist_mode,
             builtin_allowlist, builtin_allowlist_mode, allow_self_review,
             browser_tools_review_only,
             subagent_mode, execution_mode, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          finalName,
          parsed.display_name,
          parsed.description || null,
          resolved.sdk,
          model,
          effort,
          contextWindow,
          parsed.instructions || "",
          JSON.stringify(skillsAllow.list),
          skillsAllow.mode,
          JSON.stringify(mcpAllow.list),
          mcpAllow.mode,
          JSON.stringify(builtinAllow.list),
          builtinAllow.mode,
          parsed.allow_self_review === false ? 0 : 1,
          parsed.browser_tools_review_only === true ? 1 : 0,
          parsed.subagent_mode || "advisory",
          executionMode,
          parsed.enabled === false ? 0 : 1,
          now,
          now,
        );
        return { agent: agentSummary(getAgentByName(db, finalName)) };
      });
    },
  };
}
