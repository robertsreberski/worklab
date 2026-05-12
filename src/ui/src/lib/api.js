async function request(method, path, body, options = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
    signal: options.signal,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || res.statusText), { code: json?.error?.code, status: res.status });
  return json;
}

async function uploadZip(path, file) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": file?.type || "application/zip",
      "X-Skill-Filename": encodeURIComponent(file?.name || "skill.zip"),
    },
    body: file,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || res.statusText), { code: json?.error?.code, status: res.status });
  return json;
}

function pathSegment(value) {
  return encodeURIComponent(String(value ?? ""));
}

function withQuery(path, query) {
  return `${path}${query ? `?${new URLSearchParams(query)}` : ""}`;
}

export const api = {
  // projects
  listProjects: (query, options) => request("GET", `/projects${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  getProject: (id, options) => request("GET", `/projects/${encodeURIComponent(id)}`, null, options),
  createProject: (data) => request("POST", "/projects", data),
  patchProject: (id, patch) => request("PATCH", `/projects/${encodeURIComponent(id)}`, patch),
  archiveProject: (id) => request("DELETE", `/projects/${encodeURIComponent(id)}`),
  // teams
  listTeams: (query, options) => request("GET", `/teams${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  getTeam: (id, options) => request("GET", `/teams/${encodeURIComponent(id)}`, null, options),
  createTeam: (data) => request("POST", "/teams", data),
  patchTeam: (id, patch) => request("PATCH", `/teams/${encodeURIComponent(id)}`, patch),
  archiveTeam: (id) => request("DELETE", `/teams/${encodeURIComponent(id)}`),
  setTeamMembers: (id, members) => request("PUT", `/teams/${encodeURIComponent(id)}/members`, { members }),
  listTeamCycles: (id, query) => request("GET", `/teams/${encodeURIComponent(id)}/cycles${query ? "?" + new URLSearchParams(query) : ""}`),
  listTeamGoals: (id, query, options) => request("GET", `/teams/${encodeURIComponent(id)}/goals${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  patchTeamGoal: (id, projectId, patch) => request("PATCH", `/teams/${encodeURIComponent(id)}/goals/${encodeURIComponent(projectId)}`, patch),
  runTeamLead: (id, body = {}) => request("POST", `/teams/${encodeURIComponent(id)}/run-lead`, body),
  // goals
  listGoals: (query, options) => request("GET", `/goals${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  getGoal: (id, options) => request("GET", `/goals/${encodeURIComponent(id)}`, null, options),
  createGoal: (data) => request("POST", "/goals", data),
  patchGoal: (id, patch) => request("PATCH", `/goals/${encodeURIComponent(id)}`, patch),
  runGoal: (id, body = {}) => request("POST", `/goals/${encodeURIComponent(id)}/run`, body),
  // tasks
  listTasks: (query, options) => request("GET", `/tasks${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  getTask: (id, query, options) => {
    if (query?.signal && !options) {
      options = query;
      query = null;
    }
    return request("GET", withQuery(`/tasks/${pathSegment(id)}`, query), null, options);
  },
  createTask: (data) => request("POST", "/tasks", data),
  bulkTasks: (data) => request("POST", "/tasks/bulk", data),
  patchTask: (id, patch) => request("PATCH", `/tasks/${pathSegment(id)}`, patch),
  listTaskRuns: (id, query, options) => request("GET", withQuery(`/tasks/${pathSegment(id)}/runs`, query), null, options),
  createSubtask: (id, data) => request("POST", `/tasks/${pathSegment(id)}/subtasks`, data),
  listTaskAutomations: (id, options) => request("GET", `/tasks/${pathSegment(id)}/automations`, null, options),
  createTaskAutomation: (id, data) => request("POST", `/tasks/${pathSegment(id)}/automations`, data),
  getTaskAutomation: (taskId, automationId) => request("GET", `/tasks/${pathSegment(taskId)}/automations/${pathSegment(automationId)}`),
  patchTaskAutomation: (taskId, automationId, patch) => request("PATCH", `/tasks/${pathSegment(taskId)}/automations/${pathSegment(automationId)}`, patch),
  deleteTaskAutomation: (taskId, automationId) => request("DELETE", `/tasks/${pathSegment(taskId)}/automations/${pathSegment(automationId)}`),
  runTaskAutomation: (taskId, automationId) => request("POST", `/tasks/${pathSegment(taskId)}/automations/${pathSegment(automationId)}/run`),
  deleteTask: (id) => request("DELETE", `/tasks/${pathSegment(id)}`),
  addComment: (id, body, options = {}) => request("POST", `/tasks/${pathSegment(id)}/comments`, { body, rerun: options.rerun === true }),
  answerPendingQuestions: (id, answers) => request("POST", `/tasks/${pathSegment(id)}/pending-questions/answer`, { answers }),
  deleteComment: (id, commentId) => request("DELETE", `/tasks/${pathSegment(id)}/comments/${pathSegment(commentId)}`),
  previewTaskRun: (id) => request("GET", `/tasks/${pathSegment(id)}/run-preview`),
  runTask: (id) => request("POST", `/tasks/${pathSegment(id)}/run`),
  cancelTask: (id) => request("POST", `/tasks/${pathSegment(id)}/cancel`),
  // runs
  getRun: (id, options) => request("GET", `/runs/${pathSegment(id)}`, null, options),
  getRunCostSummary: () => request("GET", "/runs/cost-summary"),
  sendRunMessage: (id, body) => request("POST", `/runs/${pathSegment(id)}/messages`, { body }),
  // activity/search
  listActivity: (query, options) => request("GET", `/activity${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  search: (query) => request("GET", `/search?${new URLSearchParams(query)}`),
  searchMentions: (query, options) => request("GET", `/mentions/search?${new URLSearchParams(query)}`, null, options),
  searchStatus: () => request("GET", "/search/status"),
  // settings
  getSettings: (options) => request("GET", "/settings", null, options),
  patchSettings: (patch) => request("PATCH", "/settings", patch),
  getRuntimeSettings: () => request("GET", "/settings/runtime"),
  patchRuntimeSettings: (patch) => request("PATCH", "/settings/runtime", patch),
  restartRuntime: () => request("POST", "/settings/runtime/restart"),
  getNotificationStatus: () => request("GET", "/notifications/status"),
  subscribePushNotifications: (data) => request("POST", "/notifications/subscriptions", data),
  unsubscribePushNotifications: (endpoint) => request("DELETE", "/notifications/subscriptions", { endpoint }),
  testPushNotifications: () => request("POST", "/notifications/test"),
  getSlackStatus: () => request("GET", "/slack/status"),
  // assistant
  getAssistant: (query, options) => request("GET", `/assistant${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  getAssistantMessages: (query, options) => request("GET", `/assistant/messages${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  sendAssistantMessage: (body, viewContext = null) => request(
    "POST",
    "/assistant/messages",
    viewContext ? { body, view_context: viewContext } : { body },
  ),
  getAssistantRun: (id, query, options) => request("GET", `/assistant/runs/${pathSegment(id)}${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  cancelAssistantRun: (id) => request("POST", `/assistant/runs/${pathSegment(id)}/cancel`),
  // agents
  listAgents: (query, options) => {
    if (query?.signal && !options) {
      options = query;
      query = null;
    }
    return request("GET", `/agents${query ? "?" + new URLSearchParams(query) : ""}`, null, options);
  },
  getAgent: (name, options) => request("GET", `/agents/${pathSegment(name)}`, null, options),
  getAgentMemory: (name) => request("GET", `/agents/${pathSegment(name)}/memory`),
  listAgentMemories: (name, query, options) => request("GET", `/agents/${pathSegment(name)}/memories${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  patchAgentMemory: (name, memoryId, patch) => request("PATCH", `/agents/${pathSegment(name)}/memories/${pathSegment(memoryId)}`, patch),
  createAgent: (data) => request("POST", "/agents", data),
  patchAgent: (name, patch) => request("PATCH", `/agents/${pathSegment(name)}`, patch),
  deleteAgent: (name) => request("DELETE", `/agents/${pathSegment(name)}`),
  consolidateAgent: (name) => request("POST", `/agents/${pathSegment(name)}/consolidate`),
  listAgentRuns: (name, limit = 20) => request("GET", `/agents/${pathSegment(name)}/runs?limit=${limit}`),
  getAgentJournal: (name, runId) => request("GET", `/agents/${pathSegment(name)}/journal?run=${encodeURIComponent(runId)}`),
  // skills
  listSkills: (options) => request("GET", "/skills", null, options),
  getSkill: (name) => request("GET", `/skills/${pathSegment(name)}`),
  createSkill: (data) => request("POST", "/skills", data),
  importSkillZip: (file) => uploadZip("/skills/import", file),
  patchSkill: (name, patch) => request("PATCH", `/skills/${pathSegment(name)}`, patch),
  deleteSkill: (name) => request("DELETE", `/skills/${pathSegment(name)}`),
  skillUsage: (name) => request("GET", `/skills/${pathSegment(name)}/usage`),
  // mcp
  getMcpConfig: () => request("GET", "/mcp"),
  getMcpStatus: () => request("GET", "/mcp/status"),
  checkMcpHealth: (data) => request("POST", "/mcp/health", data),
  putMcpConfig: (data) => request("PUT", "/mcp", data),
  // kb
  listKb: (query, options) => request("GET", `/kb${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  kbTaxonomy: (options) => request("GET", "/kb/taxonomy", null, options),
  getKb: (slug) => request("GET", `/kb/${encodeURIComponent(slug)}`),
  createKb: (data) => request("POST", "/kb", data),
  patchKb: (slug, patch) => request("PATCH", `/kb/${encodeURIComponent(slug)}`, patch),
  deleteKb: (slug) => request("DELETE", `/kb/${encodeURIComponent(slug)}`),
  kbUsage: (slug) => request("GET", `/kb/${encodeURIComponent(slug)}/usage`),
  // providers/models
  listProviders: (options) => request("GET", "/providers", null, options),
  getProvider: (id) => request("GET", `/providers/${pathSegment(id)}`),
  createProvider: (data) => request("POST", "/providers", data),
  patchProvider: (id, patch) => request("PATCH", `/providers/${pathSegment(id)}`, patch),
  deleteProvider: (id) => request("DELETE", `/providers/${pathSegment(id)}`),
  providerAgents: (id) => request("GET", `/providers/${pathSegment(id)}/agents`),
  testProvider: (id) => request("POST", `/providers/${pathSegment(id)}/test`),
  discoverProviderModels: (id) => request("POST", `/providers/${pathSegment(id)}/discover`),
  listProviderModels: (id) => request("GET", `/providers/${pathSegment(id)}/models`),
  patchProviderModel: (providerId, modelId, patch) => request("PATCH", `/providers/${pathSegment(providerId)}/models/${pathSegment(modelId)}`, patch),
  listAvailableModels: () => request("GET", "/models/available"),
  listEmbeddingModels: () => request("GET", "/models/embeddings"),
  listVerificationAdjudicatorModels: () => request("GET", "/models/verification-adjudicators"),
  // automations
  listAutomations: () => request("GET", "/automations"),
  getAutomation: (id) => request("GET", `/automations/${pathSegment(id)}`),
  createAutomation: (data) => request("POST", "/automations", data),
  patchAutomation: (id, patch) => request("PATCH", `/automations/${pathSegment(id)}`, patch),
  deleteAutomation: (id) => request("DELETE", `/automations/${pathSegment(id)}`),
  runAutomation: (id) => request("POST", `/automations/${pathSegment(id)}/run`),
};
