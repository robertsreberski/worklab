import { parseHashRoute } from "./navigation.js";

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
  const parsed = parseHashRoute(hash);
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

  if (parsed.route === "library") {
    const tab = first || "agents";
    const [item, mode] = parsed.rest.slice(1);
    if (tab === "agents") {
      if (!item) return baseContext(parsed, "agent_list");
      if (item === "new") return baseContext(parsed, "agent_new");
      return resourceContext(parsed, "agent_detail", "agent", item);
    }
    if (tab === "teams") {
      if (!item) return baseContext(parsed, "team_list");
      if (item === "new") return baseContext(parsed, "team_new");
      if (mode === "edit") return resourceContext(parsed, "team_edit", "team", item, { mode: "edit" });
      return resourceContext(parsed, "team_detail", "team", item, { mode: mode || null });
    }
    if (tab === "skills") {
      if (!item) return baseContext(parsed, "skill_list");
      if (item === "new") return baseContext(parsed, "skill_new");
      return resourceContext(parsed, "skill_detail", "skill", item);
    }
    if (tab === "knowledge") {
      if (!item) return baseContext(parsed, "knowledge_list");
      if (item === "new") return baseContext(parsed, "knowledge_new");
      if (mode === "edit") return resourceContext(parsed, "knowledge_edit", "knowledge", item, { mode: "edit" });
      return resourceContext(parsed, "knowledge_detail", "knowledge", item, { mode: mode || null });
    }
    return baseContext(parsed, "library");
  }

  if (parsed.route === "runs") return baseContext(parsed, "runs");
  if (parsed.route === "settings") {
    const tab = first || "general";
    if (tab === "providers") {
      const [item] = parsed.rest.slice(1);
      if (!item) return baseContext(parsed, "provider_list");
      if (item === "new") return baseContext(parsed, "provider_new");
      return resourceContext(parsed, "provider_detail", "provider", item);
    }
    return baseContext(parsed, `settings_${tab}`);
  }
  if (parsed.route === "design-system") return baseContext(parsed, "design_system");
  if (parsed.route === "automations") return baseContext(parsed, "automation_list");

  return baseContext(parsed, "unknown");
}

export function assistantViewContextFromLocation(location = globalThis.location) {
  const context = assistantViewContextFromHash(location?.hash || "");
  if (location?.pathname) context.pathname = location.pathname;
  return context;
}
