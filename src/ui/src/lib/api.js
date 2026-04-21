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
  listTasks: () => request("GET", "/tasks"),
  getTask: (id) => request("GET", `/tasks/${id}`),
  createTask: (data) => request("POST", "/tasks", data),
  patchTask: (id, patch) => request("PATCH", `/tasks/${id}`, patch),
  deleteTask: (id) => request("DELETE", `/tasks/${id}`),
  addComment: (id, body) => request("POST", `/tasks/${id}/comments`, { body }),
  getSettings: () => request("GET", "/settings"),
  patchSettings: (patch) => request("PATCH", "/settings", patch),
};
