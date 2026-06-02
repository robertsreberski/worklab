// Shared JSON-Schema builders and compact-output helpers for the MCP tool
// modules under src/mcp/admin/tools/ and src/mcp/agent/tools/.

export const string = (description) => ({ type: "string", description });
export const number = (description) => ({ type: "number", description });
export const boolean = (description) => ({ type: "boolean", description });
export const arrayOfString = (description) => ({
  type: "array",
  items: { type: "string" },
  description,
});
export const object = (properties = {}, required = [], additionalProperties = false) => ({
  type: "object",
  properties,
  required,
  additionalProperties,
});

export function tool(name, description, inputSchema = object(), extra = {}) {
  return { name, description, inputSchema, ...extra };
}

// Common typed slots reused across many definitions.
export const idSchema = string("Identifier");
export const taskIdSchema = string("Task id or public task key");
export const projectIdSchema = string("Project id or slug");
export const slugSchema = string("Slug");
export const patchSchema = object({}, [], true);

export function definedEntries(obj) {
  return Object.fromEntries(
    Object.entries(obj || {}).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

export function encodePath(path, input) {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      throw new Error(`${key} is required`);
    }
    return encodeURIComponent(String(input[key]));
  });
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

export function compactAllowlist(row, listKey, modeKey) {
  const list = Array.isArray(row?.[listKey]) ? row[listKey] : [];
  return {
    mode: row?.[modeKey] || "all",
    count: list.length,
  };
}

export function compactTask(row) {
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

export function compactTaskResponse(result) {
  return { task: compactTask(result?.task) };
}

export function compactAgent(row) {
  return {
    name: row.name,
    display_name: row.display_name || row.name,
    description: row.description || null,
    sdk: row.sdk || null,
    model: row.model || null,
    effort: row.effort || null,
    context_window: row.context_window || "default",
    fast_mode: !!row.fast_mode,
    execution_mode: row.execution_mode || null,
    enabled: row.enabled !== false,
    allow_self_review: !!row.allow_self_review,
    browser_tools_review_only: !!row.browser_tools_review_only,
    skills_allowlist: compactAllowlist(row, "skills_allowlist", "skills_allowlist_mode"),
    mcp_allowlist: compactAllowlist(row, "mcp_allowlist", "mcp_allowlist_mode"),
    builtin_allowlist: compactAllowlist(row, "builtin_allowlist", "builtin_allowlist_mode"),
    last_run_at: row.last_run_at || null,
    run_count_30d: Number(row.run_count_30d) || 0,
    avg_run_duration_ms: row.avg_run_duration_ms == null ? null : Number(row.avg_run_duration_ms),
  };
}

export function compactAgentList(result, input = {}) {
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
      agent.context_window,
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
    supports_fast_mode: !!capabilities.supports_fast_mode,
    max_tokens: Number(capabilities.max_tokens) || null,
    reasoning: !!capabilities.reasoning,
    reasoning_levels: Array.isArray(capabilities.reasoning_levels) ? capabilities.reasoning_levels : [],
    supports_tools: capabilities.tool_use !== false && model.supports_builtin_tools !== false,
    supports_mcp: model.supports_mcp !== false && capabilities.supports_mcp !== false,
    supports_skills: model.supports_skills !== false && capabilities.supports_skills !== false,
  };
}

export function compactModelAvailable(result, input = {}) {
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
