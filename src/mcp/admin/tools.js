import { spawn } from "node:child_process";
import { join } from "node:path";
import { serviceStatus } from "../../cli/install-service.js";

const string = (description) => ({ type: "string", description });
const number = (description) => ({ type: "number", description });
const boolean = (description) => ({ type: "boolean", description });
const arrayOfString = (description) => ({ type: "array", items: { type: "string" }, description });
const object = (properties = {}, required = [], additionalProperties = false) => ({
  type: "object",
  properties,
  required,
  additionalProperties,
});

function tool(name, description, inputSchema = object()) {
  return { name, description, inputSchema };
}

const id = string("Identifier");
const taskId = string("Task id or public task key");
const projectId = string("Project id or slug");
const slug = string("Slug");
const patch = object({}, [], true);
const taskCreateInput = object({
  title: string("Task title"),
  instructions: string("Task instructions"),
  owner_agent: string("Owner agent name"),
  planner_agent: string("Planner agent name"),
  reviewer_agent: string("Reviewer agent name"),
  stage: string("Initial workflow stage"),
  run_policy: string("Run policy: manual or auto_plan_execute"),
  project_id: string("Optional project id or slug"),
  tags: arrayOfString("Tags"),
  blocked_by_ids: arrayOfString("Dependency task ids or public task keys"),
  client_request_id: string("Idempotency key"),
}, ["title"]);
const agentCreateInput = object({
  name: string("Optional lowercase slug. If omitted, Worklab generates one from display_name."),
  display_name: string("Agent display name"),
  model: string("Explicit model reference, for example codex:gpt-5.5 or claude:claude-sonnet-4-6"),
  effort: string("Reasoning effort: none, low, medium, high, xhigh, or max"),
  description: string("Short description"),
  instructions: string("Agent instructions"),
  skills_allowlist: arrayOfString("Allowed skills when skills_allowlist_mode is custom"),
  skills_allowlist_mode: string("Skill allowlist mode: all or custom"),
  mcp_allowlist: arrayOfString("Allowed MCP servers when mcp_allowlist_mode is custom"),
  mcp_allowlist_mode: string("MCP allowlist mode: all or custom"),
  builtin_allowlist: arrayOfString("Allowed built-in tools when builtin_allowlist_mode is custom"),
  builtin_allowlist_mode: string("Built-in allowlist mode: all or custom"),
  allow_self_review: boolean("Whether the agent may review its own runs"),
  daily_budget_usd: number("Daily budget in USD"),
  per_run_budget_usd: number("Per-run budget in USD"),
  enabled: boolean("Whether the agent is enabled"),
}, ["display_name", "model"]);

export const adminToolDefinitions = [
  tool("worklab_status", "Return Worklab health, service metadata, and configuration summary."),
  tool("worklab_service_status", "Return per-user service installation and active-state metadata."),
  tool("worklab_service_restart", "Request a Worklab service restart."),
  tool("worklab_service_stop", "Request a Worklab service stop."),

  tool("worklab_project_list", "List projects, optionally including archived projects.", object({
    q: string("Search query"),
    include_archived: boolean("Include archived projects"),
  })),
  tool("worklab_project_get", "Get a project with task summary and stage counts.", object({ id: projectId }, ["id"])),
  tool("worklab_project_create", "Create a project.", object({
    name: string("Project name"),
    slug: string("Optional URL-safe slug"),
    description: string("Short project description"),
    context: string("Markdown context inserted into every assigned task run"),
    workdir: string("Optional run workdir override"),
    tags: arrayOfString("Tags"),
    archived: boolean("Whether the project starts archived"),
  }, ["name"])),
  tool("worklab_project_update", "Patch a project.", object({ id: projectId, patch }, ["id", "patch"])),
  tool("worklab_project_archive", "Archive a project without deleting linked tasks.", object({ id: projectId }, ["id"])),

  tool("worklab_task_list", "List tasks, optionally filtered by stage, agent, or project.", object({
    stage: string("Workflow stage filter"),
    agent: string("Owner or reviewer agent filter"),
    project: string("Project id, slug, or 'none'"),
  })),
  tool("worklab_task_get", "Get a task with comments, runs, and graph context.", object({ id: taskId }, ["id"])),
  tool("worklab_task_create", "Create a task and return a compact task summary.", taskCreateInput),
  tool("worklab_task_create_many", "Create multiple tasks sequentially and return compact summaries.", object({
    tasks: { type: "array", items: taskCreateInput, description: "Tasks to create" },
  }, ["tasks"])),
  tool("worklab_task_update", "Patch a task. Use the same fields accepted by PATCH /api/tasks/:id.", object({ id: taskId, patch }, ["id", "patch"])),
  tool("worklab_task_bulk_update", "Patch multiple tasks by id or public task key.", object({
    ids: { type: "array", items: taskId, description: "Task ids or public task keys" },
    patch,
  }, ["ids", "patch"])),
  tool("worklab_task_delete", "Delete a task.", object({ id: taskId }, ["id"])),
  tool("worklab_task_comment", "Add a human comment to a task.", object({ id: taskId, body: string("Comment body") }, ["id", "body"])),
  tool("worklab_task_comment_delete", "Delete a human comment from a task.", object({
    id: taskId,
    comment_id: string("Comment id"),
  }, ["id", "comment_id"])),
  tool("worklab_task_create_subtask", "Create a subtask under a parent task.", object({
    id: taskId,
    title: string("Subtask title"),
    instructions: string("Subtask instructions"),
    owner_agent: string("Owner agent name"),
    planner_agent: string("Planner agent name"),
    reviewer_agent: string("Reviewer agent name"),
    required: boolean("Whether parent waits for this subtask"),
  }, ["id", "title"])),
  tool("worklab_task_run", "Start a task run.", object({ id: taskId }, ["id"])),
  tool("worklab_task_cancel", "Cancel or reconcile the active run for a task.", object({ id: taskId }, ["id"])),

  tool("worklab_agent_list", "List compact agent summaries. Use worklab_agent_get for full instructions and detailed allowlists.", object({
    q: string("Search query"),
    enabled: boolean("Filter by enabled state"),
    limit: number("Max agents to return"),
  })),
  tool("worklab_agent_get", "Get an agent.", object({ name: string("Agent name") }, ["name"])),
  tool("worklab_agent_create", "Create an agent and return a compact agent summary.", agentCreateInput),
  tool("worklab_agent_update", "Patch an agent. Use fields accepted by PATCH /api/agents/:name.", object({ name: string("Agent name"), patch }, ["name", "patch"])),
  tool("worklab_agent_delete", "Delete an agent.", object({ name: string("Agent name") }, ["name"])),
  tool("worklab_agent_consolidate", "Start forced memory consolidation for an agent.", object({ name: string("Agent name") }, ["name"])),
  tool("worklab_agent_runs", "List recent runs for an agent.", object({ name: string("Agent name"), limit: number("Max runs") }, ["name"])),
  tool("worklab_agent_journal", "Read the journal section for a specific run.", object({ name: string("Agent name"), run: string("Run id") }, ["name", "run"])),

  tool("worklab_run_get", "Get a run and its event log.", object({ id }, ["id"])),
  tool("worklab_activity_list", "List recent Worklab activity.", object({
    limit: number("Max items"),
    cursor: number("Pagination cursor"),
    agent: string("Agent filter"),
    status: string("Run status filter"),
    from: string("Start time filter"),
    to: string("End time filter"),
  })),

  tool("worklab_kb_list", "List Worklab Knowledge Base entries. In Worklab tool names, `kb` means Knowledge Base, not kilobytes.", object({
    tag: string("Tag filter"),
    category: string("Category filter"),
    pinned: boolean("Pinned filter"),
  })),
  tool("worklab_kb_read", "Read a Worklab Knowledge Base entry.", object({ slug }, ["slug"])),
  tool("worklab_kb_create", "Create a Worklab Knowledge Base entry.", object({
    slug,
    title: string("Title"),
    body: string("Markdown body"),
    tags: arrayOfString("Tags"),
    category: string("Category"),
    pinned: boolean("Pinned"),
  }, ["title"])),
  tool("worklab_kb_update", "Patch a Worklab Knowledge Base entry.", object({ slug, patch }, ["slug", "patch"])),
  tool("worklab_kb_delete", "Delete a Worklab Knowledge Base entry.", object({ slug }, ["slug"])),
  tool("worklab_search", "Search the Worklab Knowledge Base, journals, and memories.", object({
    query: string("Search query"),
    kind: string("all, kb, journal, or memory"),
    agent: string("Optional agent scope"),
    limit: number("Max results"),
  }, ["query"])),

  tool("worklab_skill_list", "List skills."),
  tool("worklab_skill_get", "Get a skill.", object({ name: string("Skill name") }, ["name"])),
  tool("worklab_skill_create", "Create a skill.", object({ name: string("Skill name"), meta: patch, body: string("Skill body") })),
  tool("worklab_skill_update", "Patch a skill.", object({ name: string("Skill name"), patch }, ["name", "patch"])),
  tool("worklab_skill_delete", "Delete a skill.", object({ name: string("Skill name") }, ["name"])),
  tool("worklab_skill_usage", "List agents that can use a skill.", object({ name: string("Skill name") }, ["name"])),

  tool("worklab_automation_list", "List automations."),
  tool("worklab_automation_get", "Get an automation.", object({ id }, ["id"])),
  tool("worklab_automation_create", "Create an automation.", object({}, ["title"], true)),
  tool("worklab_automation_update", "Patch an automation.", object({ id, patch }, ["id", "patch"])),
  tool("worklab_automation_delete", "Delete an automation.", object({ id }, ["id"])),
  tool("worklab_automation_run", "Run an automation once now.", object({ id }, ["id"])),

  tool("worklab_provider_list", "List custom providers."),
  tool("worklab_provider_get", "Get a custom provider.", object({ id }, ["id"])),
  tool("worklab_provider_create", "Create a custom provider.", object({}, ["name", "provider_type"], true)),
  tool("worklab_provider_update", "Patch a custom provider.", object({ id, patch }, ["id", "patch"])),
  tool("worklab_provider_delete", "Delete a custom provider.", object({ id }, ["id"])),
  tool("worklab_provider_test", "Test a custom provider connection.", object({ id }, ["id"])),
  tool("worklab_provider_discover", "Discover models for a custom provider.", object({ id }, ["id"])),
  tool("worklab_provider_models", "List models for a custom provider.", object({ id }, ["id"])),
  tool("worklab_provider_model_update", "Patch a provider model.", object({ id, modelId: string("Model row id"), patch }, ["id", "modelId", "patch"])),
  tool("worklab_model_available", "List compact model choices. Use provider/model detail tools or worklab_api_request for full raw metadata.", object({
    q: string("Search query"),
    sdk: string("Filter by SDK/provider family, for example codex, openai, claude, vercel, or pi"),
    available: boolean("Filter by availability"),
    limit: number("Max models to return"),
  })),
  tool("worklab_model_embeddings", "List embedding model options."),

  tool("worklab_settings_get", "Get Worklab settings."),
  tool("worklab_settings_update", "Patch Worklab settings.", object({ patch }, ["patch"])),
  tool("worklab_mcp_config_get", "Get configured external MCP servers."),
  tool("worklab_mcp_config_set", "Replace configured external MCP servers.", object({ mcpServers: patch }, ["mcpServers"])),
  tool("worklab_mcp_status", "List built-in and configured MCP server availability."),

  tool("worklab_api_request", "Full-access escape hatch for Worklab HTTP API routes under /api/*.", object({
    method: string("HTTP method"),
    path: string("Path beginning with /api/"),
    query: patch,
    body: patch,
  }, ["method", "path"])),
];

function definedEntries(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function encodePath(path, input) {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      throw new Error(`${key} is required`);
    }
    return encodeURIComponent(String(input[key]));
  });
}

export async function apiRequest({ baseUrl, fetchImpl = fetch }, method, path, { query, body } = {}) {
  if (!path.startsWith("/api/")) throw new Error("path must start with /api/");
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(definedEntries(query))) {
    url.searchParams.set(key, String(value));
  }
  const headers = {};
  const init = { method: method.toUpperCase(), headers };
  if (body !== undefined && init.method !== "GET" && init.method !== "HEAD") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, init);
  if (res.status === 204) return { ok: true, status: 204 };
  const text = await res.text();
  const parsed = text ? (() => { try { return JSON.parse(text); } catch { return { text }; } })() : {};
  if (!res.ok) {
    const message = parsed?.error?.message || parsed?.message || text || res.statusText;
    throw new Error(`${init.method} ${path} failed (${res.status}): ${message}`);
  }
  return parsed;
}

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function includesQuery(values, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return values.some((value) => String(value || "").toLowerCase().includes(q));
}

function compactAllowlist(row, listKey, modeKey) {
  const list = Array.isArray(row?.[listKey]) ? row[listKey] : [];
  return {
    mode: row?.[modeKey] || "all",
    count: list.length,
  };
}

function compactTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_key: row.task_key || null,
    title: row.title || "",
    stage: row.stage || null,
    run_policy: row.run_policy || null,
    owner_agent: row.owner_agent || null,
    planner_agent: row.planner_agent || null,
    reviewer_agent: row.reviewer_agent || null,
    project_id: row.project_id || row.project?.id || null,
    client_request_id: row.client_request_id || null,
    dependency_count: Array.isArray(row.dependency_ids)
      ? row.dependency_ids.length
      : (Array.isArray(row.blocked_by) ? row.blocked_by.length : 0),
    updated_at: row.updated_at || null,
  };
}

function compactTaskResponse(result) {
  return { task: compactTask(result?.task) };
}

function compactAgent(row) {
  return {
    name: row.name,
    display_name: row.display_name || row.name,
    description: row.description || null,
    sdk: row.sdk || null,
    model: row.model || null,
    effort: row.effort || null,
    enabled: row.enabled !== false,
    allow_self_review: !!row.allow_self_review,
    skills_allowlist: compactAllowlist(row, "skills_allowlist", "skills_allowlist_mode"),
    mcp_allowlist: compactAllowlist(row, "mcp_allowlist", "mcp_allowlist_mode"),
    builtin_allowlist: compactAllowlist(row, "builtin_allowlist", "builtin_allowlist_mode"),
    last_run_at: row.last_run_at || null,
    run_count_30d: Number(row.run_count_30d) || 0,
    avg_run_duration_ms: row.avg_run_duration_ms == null ? null : Number(row.avg_run_duration_ms),
  };
}

function compactAgentList(result, input = {}) {
  const all = Array.isArray(result?.agents) ? result.agents : [];
  const filtered = all.filter((agent) => {
    if (typeof input.enabled === "boolean" && (agent.enabled !== false) !== input.enabled) return false;
    return includesQuery([
      agent.name,
      agent.display_name,
      agent.description,
      agent.sdk,
      agent.model,
      agent.effort,
    ], input.q);
  });
  const limit = clampLimit(input.limit, 50, 200);
  const agents = filtered.slice(0, limit).map(compactAgent);
  return {
    agents,
    count: all.length,
    matched: filtered.length,
    returned: agents.length,
    truncated: filtered.length > agents.length,
    hint: "Use worklab_agent_get with a specific agent name for full instructions and detailed allowlists.",
  };
}

function modelEntries(result) {
  const groups = Array.isArray(result?.groups) ? result.groups : [];
  if (groups.length) {
    return groups.flatMap((group) => (group.models || []).map((model) => ({ group, model })));
  }
  return (result?.models || []).map((model) => ({ group: null, model }));
}

function compactModel({ group, model }) {
  const capabilities = model.capabilities || {};
  return {
    value: model.value || null,
    label: model.label || model.model || model.model_name || null,
    description: model.description || null,
    sdk: model.sdk || null,
    provider: model.provider || model.provider_name || group?.id || null,
    provider_label: group?.label || model.provider_name || null,
    model: model.model || model.model_name || null,
    available: model.available !== false && model.disabled !== true,
    unavailable_reason: model.unavailable_reason || null,
    runtime_kind: model.runtime_kind || capabilities.runtime_kind || group?.runtime_kind || null,
    context_window: Number(capabilities.context_window || capabilities.num_ctx) || null,
    max_tokens: Number(capabilities.max_tokens) || null,
    reasoning: !!capabilities.reasoning,
    reasoning_levels: Array.isArray(capabilities.reasoning_levels) ? capabilities.reasoning_levels : [],
    supports_tools: capabilities.tool_use !== false && model.supports_builtin_tools !== false,
    supports_mcp: model.supports_mcp !== false && capabilities.supports_mcp !== false,
    supports_skills: model.supports_skills !== false && capabilities.supports_skills !== false,
  };
}

function compactModelAvailable(result, input = {}) {
  const all = modelEntries(result);
  const sdkFilter = String(input.sdk || "").trim().toLowerCase();
  const filtered = all.filter(({ group, model }) => {
    const compact = compactModel({ group, model });
    if (sdkFilter && ![compact.sdk, compact.provider, group?.id].some((value) => String(value || "").toLowerCase() === sdkFilter)) {
      return false;
    }
    if (typeof input.available === "boolean" && compact.available !== input.available) return false;
    return includesQuery([
      compact.value,
      compact.label,
      compact.description,
      compact.sdk,
      compact.provider,
      compact.provider_label,
      compact.model,
    ], input.q);
  });
  const limit = clampLimit(input.limit, 80, 300);
  const models = filtered.slice(0, limit).map(compactModel);
  const availableCount = all.filter((entry) => compactModel(entry).available).length;
  return {
    models,
    count: all.length,
    available_count: availableCount,
    matched: filtered.length,
    returned: models.length,
    truncated: filtered.length > models.length,
    hint: "This is compact MCP output. Use worklab_api_request GET /api/models/available only when full raw metadata is required.",
  };
}

const specs = [
  ["worklab_project_list", "GET", "/api/projects", ["q", "include_archived"]],
  ["worklab_project_get", "GET", "/api/projects/:id"],
  ["worklab_project_create", "POST", "/api/projects", [], "input"],
  ["worklab_project_update", "PATCH", "/api/projects/:id", [], "patch"],
  ["worklab_project_archive", "DELETE", "/api/projects/:id"],
  ["worklab_task_list", "GET", "/api/tasks", ["stage", "agent", "project"]],
  ["worklab_task_get", "GET", "/api/tasks/:id"],
  ["worklab_task_create", "POST", "/api/tasks", [], "input"],
  ["worklab_task_update", "PATCH", "/api/tasks/:id", [], "patch"],
  ["worklab_task_delete", "DELETE", "/api/tasks/:id"],
  ["worklab_task_comment", "POST", "/api/tasks/:id/comments", [], "comment"],
  ["worklab_task_comment_delete", "DELETE", "/api/tasks/:id/comments/:comment_id"],
  ["worklab_task_create_subtask", "POST", "/api/tasks/:id/subtasks", [], "subtask"],
  ["worklab_task_run", "POST", "/api/tasks/:id/run"],
  ["worklab_task_cancel", "POST", "/api/tasks/:id/cancel"],
  ["worklab_agent_list", "GET", "/api/agents"],
  ["worklab_agent_get", "GET", "/api/agents/:name"],
  ["worklab_agent_create", "POST", "/api/agents", [], "input"],
  ["worklab_agent_update", "PATCH", "/api/agents/:name", [], "patch"],
  ["worklab_agent_delete", "DELETE", "/api/agents/:name"],
  ["worklab_agent_consolidate", "POST", "/api/agents/:name/consolidate"],
  ["worklab_agent_runs", "GET", "/api/agents/:name/runs", ["limit"]],
  ["worklab_agent_journal", "GET", "/api/agents/:name/journal", ["run"]],
  ["worklab_run_get", "GET", "/api/runs/:id"],
  ["worklab_activity_list", "GET", "/api/activity", ["limit", "cursor", "agent", "status", "from", "to"]],
  ["worklab_kb_list", "GET", "/api/kb", ["tag", "category", "pinned"]],
  ["worklab_kb_read", "GET", "/api/kb/:slug"],
  ["worklab_kb_create", "POST", "/api/kb", [], "input"],
  ["worklab_kb_update", "PATCH", "/api/kb/:slug", [], "patch"],
  ["worklab_kb_delete", "DELETE", "/api/kb/:slug"],
  ["worklab_skill_list", "GET", "/api/skills"],
  ["worklab_skill_get", "GET", "/api/skills/:name"],
  ["worklab_skill_create", "POST", "/api/skills", [], "input"],
  ["worklab_skill_update", "PATCH", "/api/skills/:name", [], "skillPatch"],
  ["worklab_skill_delete", "DELETE", "/api/skills/:name"],
  ["worklab_skill_usage", "GET", "/api/skills/:name/usage"],
  ["worklab_automation_list", "GET", "/api/automations"],
  ["worklab_automation_get", "GET", "/api/automations/:id"],
  ["worklab_automation_create", "POST", "/api/automations", [], "input"],
  ["worklab_automation_update", "PATCH", "/api/automations/:id", [], "patch"],
  ["worklab_automation_delete", "DELETE", "/api/automations/:id"],
  ["worklab_automation_run", "POST", "/api/automations/:id/run"],
  ["worklab_provider_list", "GET", "/api/providers"],
  ["worklab_provider_get", "GET", "/api/providers/:id"],
  ["worklab_provider_create", "POST", "/api/providers", [], "input"],
  ["worklab_provider_update", "PATCH", "/api/providers/:id", [], "patch"],
  ["worklab_provider_delete", "DELETE", "/api/providers/:id"],
  ["worklab_provider_test", "POST", "/api/providers/:id/test"],
  ["worklab_provider_discover", "POST", "/api/providers/:id/discover"],
  ["worklab_provider_models", "GET", "/api/providers/:id/models"],
  ["worklab_provider_model_update", "PATCH", "/api/providers/:id/models/:modelId", [], "patch"],
  ["worklab_model_available", "GET", "/api/models/available"],
  ["worklab_model_embeddings", "GET", "/api/models/embeddings"],
  ["worklab_settings_get", "GET", "/api/settings"],
  ["worklab_settings_update", "PATCH", "/api/settings", [], "patch"],
  ["worklab_mcp_config_get", "GET", "/api/mcp"],
  ["worklab_mcp_config_set", "PUT", "/api/mcp", [], "mcpServers"],
  ["worklab_mcp_status", "GET", "/api/mcp/status"],
];

function bodyFor(kind, input) {
  if (!kind) return undefined;
  if (kind === "input") return input;
  if (kind === "patch") return input.patch || {};
  if (kind === "mcpServers") return { mcpServers: input.mcpServers || {} };
  if (kind === "comment") return { body: input.body };
  if (kind === "subtask") {
    const { id: _id, ...body } = input;
    return body;
  }
  if (kind === "skillPatch") return input.patch || {};
  return undefined;
}

function queueCliCommand(config, command) {
  const cli = join(config.repoRoot, "src", "cli", "index.js");
  const child = spawn(process.execPath, [cli, command], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WORKLAB_DATA_DIR: config.dataDir },
  });
  child.unref();
  return { queued: true, command, pid: child.pid };
}

export function createAdminToolHandlers({ baseUrl, config, fetchImpl = fetch } = {}) {
  const client = { baseUrl, fetchImpl };
  const handlers = {};

  for (const [name, method, path, queryKeys = [], bodyKind] of specs) {
    handlers[name] = async (input = {}) => apiRequest(client, method, encodePath(path, input), {
      query: Object.fromEntries(queryKeys.map((key) => [key, input[key]])),
      body: bodyFor(bodyKind, input),
    });
  }

  handlers.worklab_task_create = async (input = {}) => compactTaskResponse(
    await apiRequest(client, "POST", "/api/tasks", { body: input }),
  );

  handlers.worklab_task_create_many = async (input = {}) => {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [];
    const results = [];
    for (const task of tasks) {
      try {
        const result = await apiRequest(client, "POST", "/api/tasks", { body: task });
        results.push({ ok: true, task: compactTask(result.task) });
      } catch (error) {
        results.push({ ok: false, error: { message: error.message || String(error) } });
      }
    }
    const succeeded = results.filter((result) => result.ok).length;
    return {
      summary: { requested: tasks.length, succeeded, failed: tasks.length - succeeded },
      results,
    };
  };

  handlers.worklab_task_bulk_update = async (input = {}) => {
    const result = await apiRequest(client, "POST", "/api/tasks/bulk", {
      body: { operation: "patch", ids: input.ids || [], patch: input.patch || {} },
    });
    return {
      summary: result.summary,
      results: (result.results || []).map((entry) => ({
        id: entry.id,
        task_id: entry.task_id || null,
        ok: !!entry.ok,
        ...(entry.task ? { task: compactTask(entry.task) } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      })),
    };
  };

  handlers.worklab_agent_create = async (input = {}) => {
    const result = await apiRequest(client, "POST", "/api/agents", { body: input });
    return { agent: compactAgent(result.agent) };
  };

  handlers.worklab_status = async () => ({
    health: await apiRequest(client, "GET", "/api/health"),
    service: await serviceStatus(),
    config: config ? {
      host: config.host,
      port: config.port,
      dataDir: config.dataDir,
      workspace: config.workspace,
      repoRoot: config.repoRoot,
    } : null,
  });

  handlers.worklab_service_status = async () => serviceStatus();
  handlers.worklab_service_restart = async () => queueCliCommand(config, "restart");
  handlers.worklab_service_stop = async () => queueCliCommand(config, "stop");

  handlers.worklab_agent_list = async (input = {}) => compactAgentList(
    await apiRequest(client, "GET", "/api/agents"),
    input,
  );

  handlers.worklab_model_available = async (input = {}) => compactModelAvailable(
    await apiRequest(client, "GET", "/api/models/available"),
    input,
  );

  handlers.worklab_search = async (input = {}) => apiRequest(client, "GET", "/api/search", {
    query: {
      q: input.query,
      kind: input.kind || "all",
      agent: input.agent,
      limit: input.limit,
    },
  });

  handlers.worklab_api_request = async (input = {}) => apiRequest(client, input.method || "GET", input.path, {
    query: input.query,
    body: input.body,
  });

  return handlers;
}
