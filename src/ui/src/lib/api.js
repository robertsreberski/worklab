async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
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
  // tasks
  listTasks: (query) => request("GET", `/tasks${query ? "?" + new URLSearchParams(query) : ""}`),
  getTask: (id) => request("GET", `/tasks/${id}`),
  createTask: (data) => request("POST", "/tasks", data),
  bulkTasks: (data) => request("POST", "/tasks/bulk", data),
  patchTask: (id, patch) => request("PATCH", `/tasks/${id}`, patch),
  createSubtask: (id, data) => request("POST", `/tasks/${id}/subtasks`, data),
  listTaskAutomations: (id) => request("GET", `/tasks/${id}/automations`),
  createTaskAutomation: (id, data) => request("POST", `/tasks/${id}/automations`, data),
  getTaskAutomation: (taskId, automationId) => request("GET", `/tasks/${taskId}/automations/${automationId}`),
  patchTaskAutomation: (taskId, automationId, patch) => request("PATCH", `/tasks/${taskId}/automations/${automationId}`, patch),
  deleteTaskAutomation: (taskId, automationId) => request("DELETE", `/tasks/${taskId}/automations/${automationId}`),
  runTaskAutomation: (taskId, automationId) => request("POST", `/tasks/${taskId}/automations/${automationId}/run`),
  deleteTask: (id) => request("DELETE", `/tasks/${id}`),
  addComment: (id, body, options = {}) => request("POST", `/tasks/${id}/comments`, { body, rerun: options.rerun === true }),
  deleteComment: (id, commentId) => request("DELETE", `/tasks/${id}/comments/${commentId}`),
  previewTaskRun: (id) => request("GET", `/tasks/${id}/run-preview`),
  runTask: (id) => request("POST", `/tasks/${id}/run`),
  cancelTask: (id) => request("POST", `/tasks/${id}/cancel`),
  // runs
  getRun: (id) => request("GET", `/runs/${id}`),
  sendRunMessage: (id, body) => request("POST", `/runs/${id}/messages`, { body }),
  // activity/search
  listActivity: (query) => request("GET", `/activity${query ? "?" + new URLSearchParams(query) : ""}`),
  search: (query) => request("GET", `/search?${new URLSearchParams(query)}`),
  searchStatus: () => request("GET", "/search/status"),
  // settings
  getSettings: () => request("GET", "/settings"),
  patchSettings: (patch) => request("PATCH", "/settings", patch),
  getRuntimeSettings: () => request("GET", "/settings/runtime"),
  patchRuntimeSettings: (patch) => request("PATCH", "/settings/runtime", patch),
  restartRuntime: () => request("POST", "/settings/runtime/restart"),
  // agents
  listAgents: () => request("GET", "/agents"),
  getAgent: (name) => request("GET", `/agents/${name}`),
  getAgentMemory: (name) => request("GET", `/agents/${name}/memory`),
  createAgent: (data) => request("POST", "/agents", data),
  patchAgent: (name, patch) => request("PATCH", `/agents/${name}`, patch),
  deleteAgent: (name) => request("DELETE", `/agents/${name}`),
  consolidateAgent: (name) => request("POST", `/agents/${name}/consolidate`),
  listAgentRuns: (name, limit = 20) => request("GET", `/agents/${name}/runs?limit=${limit}`),
  getAgentJournal: (name, runId) => request("GET", `/agents/${name}/journal?run=${encodeURIComponent(runId)}`),
  // skills
  listSkills: () => request("GET", "/skills"),
  getSkill: (name) => request("GET", `/skills/${name}`),
  createSkill: (data) => request("POST", "/skills", data),
  importSkillZip: (file) => uploadZip("/skills/import", file),
  patchSkill: (name, patch) => request("PATCH", `/skills/${name}`, patch),
  deleteSkill: (name) => request("DELETE", `/skills/${name}`),
  skillUsage: (name) => request("GET", `/skills/${name}/usage`),
  // mcp
  getMcpConfig: () => request("GET", "/mcp"),
  getMcpStatus: () => request("GET", "/mcp/status"),
  putMcpConfig: (data) => request("PUT", "/mcp", data),
  // kb
  listKb: (query) => request("GET", `/kb${query ? "?" + new URLSearchParams(query) : ""}`),
  getKb: (slug) => request("GET", `/kb/${encodeURIComponent(slug)}`),
  createKb: (data) => request("POST", "/kb", data),
  patchKb: (slug, patch) => request("PATCH", `/kb/${encodeURIComponent(slug)}`, patch),
  deleteKb: (slug) => request("DELETE", `/kb/${encodeURIComponent(slug)}`),
  kbUsage: (slug) => request("GET", `/kb/${encodeURIComponent(slug)}/usage`),
  // providers/models
  listProviders: () => request("GET", "/providers"),
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
