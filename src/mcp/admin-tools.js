import { spawn } from "node:child_process";
import { join } from "node:path";
import { serviceStatus } from "../cli/install-service.js";

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
const slug = string("Slug");
const patch = object({}, [], true);

export const adminToolDefinitions = [
  tool("worklab_status", "Return Worklab health, service metadata, and configuration summary."),
  tool("worklab_service_status", "Return per-user service installation and active-state metadata."),
  tool("worklab_service_restart", "Request a Worklab service restart."),
  tool("worklab_service_stop", "Request a Worklab service stop."),

  tool("worklab_task_list", "List tasks, optionally filtered by stage or agent.", object({
    stage: string("Workflow stage filter"),
    agent: string("Owner or reviewer agent filter"),
  })),
  tool("worklab_task_get", "Get a task with comments, runs, and graph context.", object({ id }, ["id"])),
  tool("worklab_task_create", "Create a task.", object({
    title: string("Task title"),
    instructions: string("Task instructions"),
    owner_agent: string("Owner agent name"),
    reviewer_agent: string("Reviewer agent name"),
    stage: string("Initial workflow stage"),
    run_policy: string("Run policy: manual or auto_plan_execute"),
    tags: arrayOfString("Tags"),
    blocked_by_ids: arrayOfString("Dependency task ids"),
    client_request_id: string("Idempotency key"),
  }, ["title"])),
  tool("worklab_task_update", "Patch a task. Use the same fields accepted by PATCH /api/tasks/:id.", object({ id, patch }, ["id", "patch"])),
  tool("worklab_task_delete", "Delete a task.", object({ id }, ["id"])),
  tool("worklab_task_comment", "Add a human comment to a task.", object({ id, body: string("Comment body") }, ["id", "body"])),
  tool("worklab_task_create_subtask", "Create a subtask under a parent task.", object({
    id,
    title: string("Subtask title"),
    instructions: string("Subtask instructions"),
    owner_agent: string("Owner agent name"),
    reviewer_agent: string("Reviewer agent name"),
    required: boolean("Whether parent waits for this subtask"),
  }, ["id", "title"])),
  tool("worklab_task_run", "Start a task run.", object({ id }, ["id"])),
  tool("worklab_task_cancel", "Cancel or reconcile the active run for a task.", object({ id }, ["id"])),

  tool("worklab_agent_list", "List agents."),
  tool("worklab_agent_get", "Get an agent.", object({ name: string("Agent name") }, ["name"])),
  tool("worklab_agent_create", "Create an agent.", object({}, ["display_name", "model"], true)),
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

  tool("worklab_kb_list", "List knowledge-base entries.", object({
    tag: string("Tag filter"),
    category: string("Category filter"),
    pinned: boolean("Pinned filter"),
  })),
  tool("worklab_kb_read", "Read a knowledge-base entry.", object({ slug }, ["slug"])),
  tool("worklab_kb_create", "Create a knowledge-base entry.", object({
    slug,
    title: string("Title"),
    body: string("Markdown body"),
    tags: arrayOfString("Tags"),
    category: string("Category"),
    pinned: boolean("Pinned"),
  }, ["title"])),
  tool("worklab_kb_update", "Patch a knowledge-base entry.", object({ slug, patch }, ["slug", "patch"])),
  tool("worklab_kb_delete", "Delete a knowledge-base entry.", object({ slug }, ["slug"])),
  tool("worklab_search", "Search KB, journals, and memories.", object({
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
  tool("worklab_model_available", "List available built-in and custom models."),
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

const specs = [
  ["worklab_task_list", "GET", "/api/tasks", ["stage", "agent"]],
  ["worklab_task_get", "GET", "/api/tasks/:id"],
  ["worklab_task_create", "POST", "/api/tasks", [], "input"],
  ["worklab_task_update", "PATCH", "/api/tasks/:id", [], "patch"],
  ["worklab_task_delete", "DELETE", "/api/tasks/:id"],
  ["worklab_task_comment", "POST", "/api/tasks/:id/comments", [], "comment"],
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
