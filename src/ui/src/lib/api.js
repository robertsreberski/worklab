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

export const api = {
  // tasks
  listTasks: (query) => request("GET", `/tasks${query ? "?" + new URLSearchParams(query) : ""}`),
  getTask: (id) => request("GET", `/tasks/${id}`),
  createTask: (data) => request("POST", "/tasks", data),
  patchTask: (id, patch) => request("PATCH", `/tasks/${id}`, patch),
  deleteTask: (id) => request("DELETE", `/tasks/${id}`),
  addComment: (id, body) => request("POST", `/tasks/${id}/comments`, { body }),
  runTask: (id) => request("POST", `/tasks/${id}/run`),
  cancelTask: (id) => request("POST", `/tasks/${id}/cancel`),
  // runs
  getRun: (id) => request("GET", `/runs/${id}`),
  // activity/search
  listActivity: (query) => request("GET", `/activity${query ? "?" + new URLSearchParams(query) : ""}`),
  search: (query) => request("GET", `/search?${new URLSearchParams(query)}`),
  searchStatus: () => request("GET", "/search/status"),
  // settings
  getSettings: () => request("GET", "/settings"),
  patchSettings: (patch) => request("PATCH", "/settings", patch),
  // agents
  listAgents: () => request("GET", "/agents"),
  getAgent: (name) => request("GET", `/agents/${name}`),
  createAgent: (data) => request("POST", "/agents", data),
  patchAgent: (name, patch) => request("PATCH", `/agents/${name}`, patch),
  deleteAgent: (name) => request("DELETE", `/agents/${name}`),
  consolidateAgent: (name) => request("POST", `/agents/${name}/consolidate`),
  // skills
  listSkills: () => request("GET", "/skills"),
  getSkill: (name) => request("GET", `/skills/${name}`),
  createSkill: (data) => request("POST", "/skills", data),
  patchSkill: (name, patch) => request("PATCH", `/skills/${name}`, patch),
  deleteSkill: (name) => request("DELETE", `/skills/${name}`),
  // mcp
  getMcpConfig: () => request("GET", "/mcp"),
  putMcpConfig: (data) => request("PUT", "/mcp", data),
  // kb
  listKb: (query) => request("GET", `/kb${query ? "?" + new URLSearchParams(query) : ""}`),
  getKb: (slug) => request("GET", `/kb/${slug}`),
  createKb: (data) => request("POST", "/kb", data),
  patchKb: (slug, patch) => request("PATCH", `/kb/${slug}`, patch),
  deleteKb: (slug) => request("DELETE", `/kb/${slug}`),
  // providers/models
  listProviders: () => request("GET", "/providers"),
  getProvider: (id) => request("GET", `/providers/${id}`),
  createProvider: (data) => request("POST", "/providers", data),
  patchProvider: (id, patch) => request("PATCH", `/providers/${id}`, patch),
  deleteProvider: (id) => request("DELETE", `/providers/${id}`),
  testProvider: (id) => request("POST", `/providers/${id}/test`),
  discoverProviderModels: (id) => request("POST", `/providers/${id}/discover`),
  listProviderModels: (id) => request("GET", `/providers/${id}/models`),
  patchProviderModel: (providerId, modelId, patch) => request("PATCH", `/providers/${providerId}/models/${modelId}`, patch),
  listAvailableModels: () => request("GET", "/models/available"),
};
