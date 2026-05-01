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

export const api = {
  // projects
  listProjects: (query, options) => request("GET", `/projects${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  getProject: (id, options) => request("GET", `/projects/${encodeURIComponent(id)}`, null, options),
  createProject: (data) => request("POST", "/projects", data),
  patchProject: (id, patch) => request("PATCH", `/projects/${encodeURIComponent(id)}`, patch),
  archiveProject: (id) => request("DELETE", `/projects/${encodeURIComponent(id)}`),
  // tasks
  listTasks: (query, options) => request("GET", `/tasks${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  getTask: (id, options) => request("GET", `/tasks/${id}`, null, options),
  createTask: (data) => request("POST", "/tasks", data),
  bulkTasks: (data) => request("POST", "/tasks/bulk", data),
  patchTask: (id, patch) => request("PATCH", `/tasks/${id}`, patch),
  createSubtask: (id, data) => request("POST", `/tasks/${id}/subtasks`, data),
  listTaskAutomations: (id, options) => request("GET", `/tasks/${id}/automations`, null, options),
  createTaskAutomation: (id, data) => request("POST", `/tasks/${id}/automations`, data),
  getTaskAutomation: (taskId, automationId) => request("GET", `/tasks/${taskId}/automations/${automationId}`),
  patchTaskAutomation: (taskId, automationId, patch) => request("PATCH", `/tasks/${taskId}/automations/${automationId}`, patch),
  deleteTaskAutomation: (taskId, automationId) => request("DELETE", `/tasks/${taskId}/automations/${automationId}`),
  runTaskAutomation: (taskId, automationId) => request("POST", `/tasks/${taskId}/automations/${automationId}/run`),
  deleteTask: (id) => request("DELETE", `/tasks/${id}`),
  addComment: (id, body, options = {}) => request("POST", `/tasks/${id}/comments`, { body, rerun: options.rerun === true }),
  deleteComment: (id, commentId) => request("DELETE", `/tasks/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`),
  previewTaskRun: (id) => request("GET", `/tasks/${id}/run-preview`),
  runTask: (id) => request("POST", `/tasks/${id}/run`),
  cancelTask: (id) => request("POST", `/tasks/${id}/cancel`),
  // runs
  getRun: (id, options) => request("GET", `/runs/${id}`, null, options),
  getRunCostSummary: () => request("GET", "/runs/cost-summary"),
  sendRunMessage: (id, body) => request("POST", `/runs/${id}/messages`, { body }),
  // activity/search
  listActivity: (query, options) => request("GET", `/activity${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  search: (query) => request("GET", `/search?${new URLSearchParams(query)}`),
  searchStatus: () => request("GET", "/search/status"),
  // settings
  getSettings: (options) => request("GET", "/settings", null, options),
  patchSettings: (patch) => request("PATCH", "/settings", patch),
  getRuntimeSettings: () => request("GET", "/settings/runtime"),
  patchRuntimeSettings: (patch) => request("PATCH", "/settings/runtime", patch),
  restartRuntime: () => request("POST", "/settings/runtime/restart"),
  getSlackStatus: () => request("GET", "/slack/status"),
  // assistant
  getAssistant: (query, options) => request("GET", `/assistant${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  getAssistantMessages: (query, options) => request("GET", `/assistant/messages${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  sendAssistantMessage: (body) => request("POST", "/assistant/messages", { body }),
  getAssistantRun: (id, query, options) => request("GET", `/assistant/runs/${id}${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  cancelAssistantRun: (id) => request("POST", `/assistant/runs/${id}/cancel`),
  // agents
  listAgents: (options) => request("GET", "/agents", null, options),
  getAgent: (name, options) => request("GET", `/agents/${name}`, null, options),
  getAgentMemory: (name) => request("GET", `/agents/${name}/memory`),
  createAgent: (data) => request("POST", "/agents", data),
  patchAgent: (name, patch) => request("PATCH", `/agents/${name}`, patch),
  deleteAgent: (name) => request("DELETE", `/agents/${name}`),
  consolidateAgent: (name) => request("POST", `/agents/${name}/consolidate`),
  listAgentRuns: (name, limit = 20) => request("GET", `/agents/${name}/runs?limit=${limit}`),
  getAgentJournal: (name, runId) => request("GET", `/agents/${name}/journal?run=${encodeURIComponent(runId)}`),
  // skills
  listSkills: (options) => request("GET", "/skills", null, options),
  getSkill: (name) => request("GET", `/skills/${name}`),
  createSkill: (data) => request("POST", "/skills", data),
  importSkillZip: (file) => uploadZip("/skills/import", file),
  patchSkill: (name, patch) => request("PATCH", `/skills/${name}`, patch),
  deleteSkill: (name) => request("DELETE", `/skills/${name}`),
  skillUsage: (name) => request("GET", `/skills/${name}/usage`),
  // mcp
  getMcpConfig: () => request("GET", "/mcp"),
  getMcpStatus: () => request("GET", "/mcp/status"),
  checkMcpHealth: (data) => request("POST", "/mcp/health", data),
  putMcpConfig: (data) => request("PUT", "/mcp", data),
  // kb
  listKb: (query, options) => request("GET", `/kb${query ? "?" + new URLSearchParams(query) : ""}`, null, options),
  getKb: (slug) => request("GET", `/kb/${encodeURIComponent(slug)}`),
  createKb: (data) => request("POST", "/kb", data),
  patchKb: (slug, patch) => request("PATCH", `/kb/${encodeURIComponent(slug)}`, patch),
  deleteKb: (slug) => request("DELETE", `/kb/${encodeURIComponent(slug)}`),
  kbUsage: (slug) => request("GET", `/kb/${encodeURIComponent(slug)}/usage`),
  // providers/models
  listProviders: (options) => request("GET", "/providers", null, options),
  getProvider: (id) => request("GET", `/providers/${id}`),
  createProvider: (data) => request("POST", "/providers", data),
  patchProvider: (id, patch) => request("PATCH", `/providers/${id}`, patch),
  deleteProvider: (id) => request("DELETE", `/providers/${id}`),
  providerAgents: (id) => request("GET", `/providers/${id}/agents`),
  testProvider: (id) => request("POST", `/providers/${id}/test`),
  discoverProviderModels: (id) => request("POST", `/providers/${id}/discover`),
  listProviderModels: (id) => request("GET", `/providers/${id}/models`),
  patchProviderModel: (providerId, modelId, patch) => request("PATCH", `/providers/${providerId}/models/${modelId}`, patch),
  listAvailableModels: () => request("GET", "/models/available"),
  listEmbeddingModels: () => request("GET", "/models/embeddings"),
  // automations
  listAutomations: () => request("GET", "/automations"),
  getAutomation: (id) => request("GET", `/automations/${id}`),
  createAutomation: (data) => request("POST", "/automations", data),
  patchAutomation: (id, patch) => request("PATCH", `/automations/${id}`, patch),
  deleteAutomation: (id) => request("DELETE", `/automations/${id}`),
  runAutomation: (id) => request("POST", `/automations/${id}/run`),
};
