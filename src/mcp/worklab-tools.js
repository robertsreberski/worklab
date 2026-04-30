import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getTaskById } from "../core/db/queries/tasks.js";
import { appendJournalEntry, appendJournalSummary, agentMemoryPath } from "../core/journal.js";
import { openDb, runMigrations } from "../core/db.js";
import { search, indexPath, removeSource } from "../core/embeddings.js";
import { kbCreate, kbUpdate, kbDelete, kbRead, kbList, kbPath } from "../core/kb.js";
import { readRunLog } from "../core/run-logs.js";
import { getBuiltinModelByReference, normalizeReasoningEffortForModel, parseModelReference, WORKLAB_BUILTIN_TOOLS } from "../core/ai.js";
import { isValidSlug, uniqueSlug } from "../core/slugs.js";
import { getModelByProviderAndName, getProvider } from "../core/providers.js";

export const journalAppendSchema = z.object({ bullet: z.string().min(1, "bullet is required") });
export const journalSummarySchema = z.object({ text: z.string().min(1, "text is required") });
export const memoryReadSchema = z.object({});
export const runLogReadSchema = z.object({
  run_id: z.string().min(1, "run_id is required"),
  mode: z.enum(["summary", "tail", "full"]).optional(),
  limit_bytes: z.number().int().min(1000).max(5 * 1024 * 1024).optional(),
});
export const listChildrenSchema = z.object({ task_id: z.string().optional() });
export const getChildResultSchema = z.object({ child_task_id: z.string().min(1, "child_task_id is required") });
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

// Knowledge Base schemas. Tool names use `kb` as a short prefix for
// Knowledge Base, not as a kilobyte unit.
export const kbCreateSchema = z.object({
  slug: z.string().min(1, "slug is required"),
  title: z.string().min(1, "title is required"),
  body: z.string(),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

// Only these 5 keys may appear in a patch — .strict() rejects any unknown keys.
export const kbPatchSchema = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    category: z.string().nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

export const kbUpdateSchema = z.object({
  slug: z.string().min(1, "slug is required"),
  patch: kbPatchSchema,
});

export const kbDeleteSchema = z.object({
  slug: z.string().min(1, "slug is required"),
});

export const kbReadSchema = z.object({
  slug: z.string().min(1, "slug is required"),
});

export const kbListSchema = z.object({
  tag: z.string().optional(),
  category: z.string().optional(),
  pinned: z.boolean().optional(),
});

const searchSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.number().int().min(1).max(50).optional(),
});

export const kbSearchSchema = searchSchema;
export const journalSearchSchema = searchSchema.extend({
  agent: z.string().optional(),
});
export const memorySearchSchema = searchSchema.extend({
  agent: z.string().optional(),
});

async function withDb(dataDir, fn) {
  const db = openDb(join(dataDir, "worklab.db"));
  runMigrations(db);
  try { return await fn(db); } finally { db.close(); }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

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

async function bestEffortIndexKb(dataDir, slug) {
  try {
    await withDb(dataDir, (db) => indexPath({ db, dataDir, filePath: kbPath(dataDir, slug) }));
  } catch { /* watcher/startup indexer will retry */ }
}

export function createToolHandlers(context) {
  const { dataDir, agent, runId, taskId, taskTitle } = context;
  return {
    async journal_append(input) {
      const { bullet } = journalAppendSchema.parse(input);
      appendJournalEntry({ dataDir, agent, runId, taskId, taskTitle, bullet });
      return { ok: true };
    },
    async journal_summary(input) {
      const { text } = journalSummarySchema.parse(input);
      appendJournalSummary({ dataDir, agent, runId, text });
      return { ok: true };
    },
    async memory_read(input) {
      memoryReadSchema.parse(input);
      const path = agentMemoryPath(dataDir, agent);
      if (!existsSync(path)) return { content: "" };
      return { content: readFileSync(path, "utf8") };
    },

    async run_log_read(input) {
      const { run_id: targetRunId, mode, limit_bytes } = runLogReadSchema.parse(input);
      return await withDb(dataDir, (db) => readRunLog({
        db,
        dataDir,
        runId: targetRunId,
        mode: mode || "summary",
        limitBytes: limit_bytes,
      }));
    },

    async list_children(input) {
      const { task_id } = listChildrenSchema.parse(input);
      const parentId = task_id || taskId;
      if (!parentId) throw new Error("task_id is required outside of a task run context");
      return await withDb(dataDir, (db) => {
        const rows = db.prepare(`
          SELECT
            t.id, t.task_key, t.title, t.stage, t.stage_reason,
            t.owner_agent, t.reviewer_agent, t.last_failure_kind,
            t.completed_at, t.updated_at,
            e.required AS required, e.edge_type AS edge_type
          FROM task_edges e
          JOIN tasks t ON t.id = e.child_task_id
          WHERE e.parent_task_id = ? AND e.edge_type = 'subtask'
          ORDER BY t.subtask_order ASC, t.created_at ASC
        `).all(parentId);
        return {
          parent_task_id: parentId,
          children: rows.map((row) => ({
            ...row,
            required: row.required !== 0,
          })),
        };
      });
    },

    async get_child_result(input) {
      const { child_task_id } = getChildResultSchema.parse(input);
      return await withDb(dataDir, (db) => {
        const child = getTaskById(db, child_task_id);
        if (!child) throw new Error(`not_found: ${child_task_id}`);
        if (taskId) {
          const edge = db.prepare(
            "SELECT 1 FROM task_edges WHERE parent_task_id = ? AND child_task_id = ? AND edge_type = 'subtask'",
          ).get(taskId, child_task_id);
          if (!edge) throw new Error(`forbidden: ${child_task_id} is not a subtask of ${taskId}`);
        }
        const lastRun = db.prepare(`
          SELECT id, mode, stage, status, process_status, decision, failure_kind, summary, details, result_json,
                 cost_usd, started_at, ended_at
          FROM task_runs
          WHERE task_id = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT 1
        `).get(child_task_id);
        return {
          child_task_id,
          title: child.title,
          stage: child.stage,
          stage_reason: child.stage_reason,
          completed_at: child.completed_at,
          last_failure_kind: child.last_failure_kind,
          last_run: lastRun ? {
            ...lastRun,
            result: lastRun.result_json ? safeParse(lastRun.result_json) : null,
          } : null,
        };
      });
    },

    async agent_create(input) {
      const parsed = agentCreateSchema.parse(input);
      return await withDb(dataDir, (db) => {
        const resolved = validateAgentModel({ db, dataDir, model: parsed.model });
        const finalName = parsed.name || uniqueSlug(parsed.display_name, (candidate) =>
          Boolean(db.prepare("SELECT name FROM agents WHERE name = ?").get(candidate)),
          { fallback: "agent" },
        );
        if (!isValidSlug(finalName)) throw new Error("invalid name (lowercase slug required)");
        if (db.prepare("SELECT name FROM agents WHERE name = ?").get(finalName)) {
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
        return { agent: agentSummary(db.prepare("SELECT * FROM agents WHERE name = ?").get(finalName)) };
      });
    },

    async kb_create(input) {
      const { slug, title, body, tags, category, pinned } = kbCreateSchema.parse(input);
      // author is always sourced from context.agent — never from caller input
      kbCreate({ dataDir, slug, title, body, tags, category, pinned, author: agent });
      await bestEffortIndexKb(dataDir, slug);
      return { ok: true, slug };
    },

    async kb_update(input) {
      const { slug, patch } = kbUpdateSchema.parse(input);
      const existing = kbRead({ dataDir, slug });
      if (existing === null) throw new Error(`not_found: ${slug}`);
      kbUpdate({ dataDir, slug, patch });
      await bestEffortIndexKb(dataDir, slug);
      return { ok: true };
    },

    async kb_delete(input) {
      const { slug } = kbDeleteSchema.parse(input);
      const deleted = kbDelete({ dataDir, slug });
      if (!deleted) throw new Error(`not_found: ${slug}`);
      await withDb(dataDir, (db) => removeSource({ db, kind: "kb", sourceRef: `knowledge/${slug}.md` })).catch(() => {});
      return { ok: true };
    },

    async kb_read(input) {
      const { slug } = kbReadSchema.parse(input);
      const entry = kbRead({ dataDir, slug });
      if (entry === null) throw new Error(`not_found: ${slug}`);
      return { meta: entry.meta, body: entry.body };
    },

    async kb_list(input) {
      const { tag, category, pinned } = kbListSchema.parse(input);
      const entries = kbList({ dataDir, tag, category, pinned });
      return { entries };
    },

    async kb_search(input) {
      const { query, limit } = kbSearchSchema.parse(input);
      const results = await withDb(dataDir, (db) => search({ db, dataDir, query, kind: "kb", limit: limit || 8 }));
      return { results };
    },

    async journal_search(input) {
      const { query, limit, agent: targetAgent } = journalSearchSchema.parse(input);
      const results = await withDb(dataDir, (db) => search({ db, dataDir, query, kind: "journal", agent: targetAgent, limit: limit || 8 }));
      return { results };
    },

    async memory_search(input) {
      const { query, limit, agent: targetAgent } = memorySearchSchema.parse(input);
      const results = await withDb(dataDir, (db) => search({ db, dataDir, query, kind: "memory", agent: targetAgent, limit: limit || 8 }));
      return { results };
    },
  };
}

export function renderToolSurfaceMarkdown(toolNames) {
  const allow = toolNames ? new Set(toolNames) : null;
  const visible = toolDefinitions.filter((tool) => !allow || allow.has(tool.name));
  if (visible.length === 0) return "";
  return visible
    .map((tool) => {
      const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
      const params = required.length ? ` (${required.join(", ")})` : "";
      const summary = (tool.description || "").trim().split(/\n+/)[0];
      return `- \`${tool.name}\`${params}: ${summary}`;
    })
    .join("\n");
}

export const toolDefinitions = [
  {
    name: "journal_append",
    description:
      "Append a bullet entry to this agent's JOURNAL.md. Use during task execution to record facts, decisions, and corrections.",
    inputSchema: {
      type: "object",
      properties: { bullet: { type: "string", description: "One concise bullet to append" } },
      required: ["bullet"],
    },
  },
  {
    name: "journal_summary",
    description:
      "Append a summary entry to the JOURNAL.md at the end of a task. Optional.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "memory_read",
    description:
      "Read this agent's consolidated MEMORY.md for Procedures / Facts / Gotchas.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_log_read",
    description:
      "Read a compact diagnostic summary for a prior Worklab run on demand. Use mode='tail' for raw JSONL tails and mode='full' only when the complete raw log is required.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Task run id to inspect" },
        mode: { type: "string", enum: ["summary", "tail", "full"], description: "Default summary. Tail/full return raw JSONL and can be large." },
        limit_bytes: { type: "number", minimum: 1000, maximum: 5242880, description: "Tail or summary byte budget. Default 60000." },
      },
      required: ["run_id"],
    },
  },
  {
    name: "list_children",
    description:
      "List subtasks delegated under a parent task. Defaults to the current task's children when called from a task run. Returns title, stage, owner, and required flag for each child edge.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Parent task id (optional; defaults to the current task)" },
      },
    },
  },
  {
    name: "get_child_result",
    description:
      "Read a child task's most recent run summary, decision, failure kind, and structured worklab_result. Errors with `forbidden` when the named task isn't a subtask of the calling task.",
    inputSchema: {
      type: "object",
      properties: {
        child_task_id: { type: "string", description: "Child task id (must be a subtask of the current task when invoked during a run)" },
      },
      required: ["child_task_id"],
    },
  },
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
  {
    name: "kb_create",
    description:
      "Create a new Worklab Knowledge Base entry. In this tool name, `kb` means Knowledge Base, not kilobytes. Use this to preserve substantial task deliverables, research reports, runbooks, decisions, and reusable analysis. The author is set automatically from the calling agent context.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "URL-safe identifier (lowercase letters, digits, hyphens; e.g. 'my-note')",
        },
        title: { type: "string", description: "Human-readable title for the entry" },
        body: { type: "string", description: "Markdown body content" },
        tags: { type: "array", items: { type: "string" }, description: "Optional list of tag strings" },
        category: {
          type: "string",
          nullable: true,
          description: "Optional category string (null to omit)",
        },
        pinned: { type: "boolean", description: "Whether the entry is pinned (default false)" },
      },
      required: ["slug", "title", "body"],
    },
  },
  {
    name: "kb_update",
    description:
      "Update fields of an existing Worklab Knowledge Base entry by slug. Only title, body, tags, category, and pinned may be patched; unknown keys are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug of the entry to update" },
        patch: {
          type: "object",
          description: "Fields to update. Allowed keys: title, body, tags, category, pinned.",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            category: { type: "string", nullable: true },
            pinned: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["slug", "patch"],
    },
  },
  {
    name: "kb_delete",
    description: "Delete a Worklab Knowledge Base entry by slug. Throws not_found if the entry does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug of the entry to delete" },
      },
      required: ["slug"],
    },
  },
  {
    name: "kb_read",
    description:
      "Read a Worklab Knowledge Base entry by slug, returning its frontmatter metadata and body. Throws not_found if missing.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug of the entry to read" },
      },
      required: ["slug"],
    },
  },
  {
    name: "kb_list",
    description:
      "List Worklab Knowledge Base entries, optionally filtered by tag, category, or pinned status. Returns metadata only (no body). Sorted: pinned first, then by updated_at descending.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Filter to entries that include this tag" },
        category: { type: "string", description: "Filter to entries with this category" },
        pinned: { type: "boolean", description: "Filter to pinned (true) or unpinned (false) entries" },
      },
    },
  },
  {
    name: "kb_search",
    description: "Search the Worklab Knowledge Base with hybrid FTS/semantic search. Returns compact snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "journal_search",
    description: "Search agent journals with hybrid FTS/semantic search. Optionally scope to one agent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        agent: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_search",
    description: "Search consolidated agent memories with hybrid FTS/semantic search. Optionally scope to one agent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        agent: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
];
