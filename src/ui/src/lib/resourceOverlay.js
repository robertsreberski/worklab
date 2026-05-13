import { normalizeHash, parseHashRoute } from "./navigation.js";

const LIBRARY_KIND_BY_TAB = {
  agents: "agent",
  knowledge: "kb",
  skills: "skill",
  teams: "team",
};

const COLLECTION_HASHES = new Set([
  "#/goals",
  "#/projects",
  "#/runs",
  "#/tasks",
  "#/library/agents",
  "#/library/knowledge",
  "#/library/skills",
  "#/library/teams",
]);

function targetTitle(kind) {
  if (kind === "kb") return "Knowledge";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function normalizeResourceHref(href) {
  const value = String(href || "").trim();
  if (!value) return null;
  if (value.startsWith("/#/")) return normalizeHash(value.slice(1));
  if (value.startsWith("#/")) return normalizeHash(value);
  return null;
}

export function resourceOverlayTargetFromHref(href) {
  const normalized = normalizeResourceHref(href);
  if (!normalized) return null;

  const parsed = parseHashRoute(normalized);
  const { route, rest, query } = parsed;
  let kind = null;
  let tab = null;

  if (route === "library") {
    tab = rest[0] || "agents";
    kind = LIBRARY_KIND_BY_TAB[tab] || null;
    if (!kind || !rest[1]) return null;
  } else if (route === "projects") {
    kind = rest[0] ? "project" : null;
  } else if (route === "goals") {
    kind = rest[0] ? "goal" : null;
  } else if (route === "tasks") {
    kind = rest[0] ? (query.run ? "run" : "task") : null;
  } else if (route === "runs") {
    kind = "run";
  }

  if (!kind) return null;

  return {
    kind,
    title: targetTitle(kind),
    href: normalized,
    route,
    tab,
    rest: route === "library" ? rest.slice(1) : rest,
    query,
    queryString: parsed.queryString,
  };
}

export function resourceOverlayNavigationFromHash(hash) {
  const normalized = normalizeResourceHref(hash);
  if (!normalized) return { action: "ignore" };
  const target = resourceOverlayTargetFromHref(normalized);
  if (target) return { action: "open", target };
  if (COLLECTION_HASHES.has(normalized)) return { action: "close" };
  return { action: "ignore" };
}
