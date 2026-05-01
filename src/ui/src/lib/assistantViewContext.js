function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseHash(hash = "") {
  const raw = String(hash || "").replace(/^#\/?/, "");
  const [pathPart = "", queryPart = ""] = raw.split("?");
  const restPath = pathPart.replace(/^\/+/, "");
  const segments = restPath.split("/").filter(Boolean).map(safeDecode);
  const query = {};
  for (const pair of queryPart.split("&")) {
    if (!pair) continue;
    const [key, value = ""] = pair.split("=");
    query[safeDecode(key)] = safeDecode(value);
  }
  return {
    route: segments[0] || "tasks",
    rest: segments.slice(1),
    path: restPath || "tasks",
    queryString: queryPart,
    query,
  };
}

function baseContext(parsed, view) {
  return {
    route: parsed.route,
    view,
    path: parsed.path,
    hash: `#/${parsed.path}${parsed.queryString ? `?${parsed.queryString}` : ""}`,
    query: parsed.query,
  };
}

function resourceContext(parsed, view, resourceType, resourceId, extra = {}) {
  return {
    ...baseContext(parsed, view),
    resource_type: resourceType,
    resource_id: resourceId || null,
    ...extra,
  };
}

export function assistantViewContextFromHash(hash = "") {
  const parsed = parseHash(hash);
  const [first, second] = parsed.rest;

  if (parsed.route === "tasks") {
    if (!first) return baseContext(parsed, "task_list");
    if (first === "new") return baseContext(parsed, "task_new");
    if (second === "edit") return resourceContext(parsed, "task_edit", "task", first, { mode: "edit" });
    return resourceContext(parsed, "task_detail", "task", first, {
      selected_run_id: parsed.query.run || null,
    });
  }

  if (parsed.route === "projects") {
    if (!first) return baseContext(parsed, "project_list");
    if (first === "new") return baseContext(parsed, "project_new");
    if (second === "edit") return resourceContext(parsed, "project_edit", "project", first, { mode: "edit" });
    return resourceContext(parsed, "project_detail", "project", first, { mode: second || null });
  }

  if (parsed.route === "agents") {
    if (!first) return baseContext(parsed, "agent_list");
    if (first === "new") return baseContext(parsed, "agent_new");
    return resourceContext(parsed, "agent_detail", "agent", first);
  }

  if (parsed.route === "skills") {
    if (!first) return baseContext(parsed, "skill_list");
    if (first === "new") return baseContext(parsed, "skill_new");
    return resourceContext(parsed, "skill_detail", "skill", first);
  }

  if (parsed.route === "knowledge") {
    if (!first) return baseContext(parsed, "knowledge_list");
    if (first === "new") return baseContext(parsed, "knowledge_new");
    if (second === "edit") return resourceContext(parsed, "knowledge_edit", "knowledge", first, { mode: "edit" });
    return resourceContext(parsed, "knowledge_detail", "knowledge", first, { mode: second || null });
  }

  if (parsed.route === "providers") {
    if (!first) return baseContext(parsed, "provider_list");
    if (first === "new") return baseContext(parsed, "provider_new");
    return resourceContext(parsed, "provider_detail", "provider", first);
  }

  if (parsed.route === "activity") return baseContext(parsed, "activity");
  if (parsed.route === "settings") return baseContext(parsed, "settings");
  if (parsed.route === "design-system") return baseContext(parsed, "design_system");
  if (parsed.route === "automations") return baseContext(parsed, "automation_list");

  return baseContext(parsed, "unknown");
}

export function assistantViewContextFromLocation(location = globalThis.location) {
  const context = assistantViewContextFromHash(location?.hash || "");
  if (location?.pathname) context.pathname = location.pathname;
  return context;
}
