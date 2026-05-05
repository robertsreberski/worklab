import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isValidSlug, uniqueSlug } from "./slugs.js";
import {
  resolveProjectByIdOrSlug,
} from "./db/queries/projects.js";

export const PROJECT_WORKTREE_MODES = ["off", "auto", "required"];

export function projectRouteError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function parseProjectTags(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((tag) => String(tag || "").trim()).filter(Boolean))];
  }
  if (typeof value !== "string") return [];
  try {
    return parseProjectTags(JSON.parse(value || "[]"));
  } catch {
    return [];
  }
}

export function normalizeProjectWorkdir(value, fallback = undefined) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw projectRouteError(400, "validation", "workdir must be a string or null");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return resolve(homedir());
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("~")) {
    throw projectRouteError(400, "validation", "workdir must use an absolute path or ~/path");
  }
  if (!isAbsolute(trimmed)) {
    throw projectRouteError(400, "validation", "workdir must use an absolute path or ~/path");
  }
  return resolve(trimmed);
}

export function normalizeProjectSlug(value) {
  if (value === undefined || value === null || value === "") return null;
  const slug = String(value).trim().toLowerCase();
  if (!isValidSlug(slug)) {
    throw projectRouteError(400, "validation", "slug must use lowercase letters, digits, and hyphens");
  }
  return slug;
}

export function normalizeProjectWorktreeMode(value, fallback = "off") {
  if (value === undefined) return fallback;
  const mode = String(value ?? "").trim() || "off";
  if (!PROJECT_WORKTREE_MODES.includes(mode)) {
    throw projectRouteError(400, "validation", `worktree_mode must be one of: ${PROJECT_WORKTREE_MODES.join(", ")}`);
  }
  return mode;
}

export function uniqueProjectSlug(db, { name, slug, existingId = null }) {
  const requested = normalizeProjectSlug(slug);
  const candidate = uniqueSlug(requested || name, (value) => {
    const row = resolveProjectByIdOrSlug(db, value);
    return !!(row && row.id !== existingId);
  }, { fallback: "project" });
  if (!isValidSlug(candidate)) {
    throw projectRouteError(400, "validation", "slug must use lowercase letters, digits, and hyphens");
  }
  return candidate;
}

export function projectFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || "",
    context: row.context_markdown || "",
    workdir: row.workdir || null,
    worktree_mode: normalizeProjectWorktreeMode(row.worktree_mode, "off"),
    tags: parseProjectTags(row.tags_json),
    team_id: row.team_id || null,
    archived: row.archived !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    task_count: row.task_count ?? undefined,
    active_task_count: row.active_task_count ?? undefined,
  };
}

/**
 * Compact summary suitable for embedding in task list/detail responses.
 * Intentionally drops `context` and `updated_at`, so passing this into
 * `projectContextHash` would compute a stale hash. Use `projectFromRow`
 * for any code path that needs the full project state (system prompt,
 * cache key, hash recomputation).
 */
export function compactProject(row) {
  const project = projectFromRow(row);
  if (!project) return null;
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    workdir: project.workdir,
    worktree_mode: project.worktree_mode,
    archived: project.archived,
  };
}

export function resolveProjectRow(db, value) {
  if (value === undefined || value === null || value === "") return null;
  return resolveProjectByIdOrSlug(db, value) || null;
}

export function resolveProjectId(db, value) {
  if (value === undefined || value === null || value === "") return null;
  const row = resolveProjectRow(db, value);
  if (!row) throw projectRouteError(400, "validation", `project not found: ${value}`);
  return row.id;
}

/**
 * Hash all the project fields that affect the rendered system prompt or
 * the worker's resolved workdir, so changes invalidate the prompt cache.
 *
 * Requires the full project shape (`context_markdown` and `updated_at`
 * present). Pass the result of `projectFromRow` — never `compactProject`,
 * which strips both fields and would yield a stale hash.
 */
export function projectContextHash(project) {
  if (!project) return null;
  return createHash("sha256")
    .update([
      project.id || "",
      project.updated_at || "",
      project.name || "",
      project.description || "",
      project.context || project.context_markdown || "",
      project.workdir || "",
      project.worktree_mode || "",
    ].join("\0"))
    .digest("hex")
    .slice(0, 16);
}

export function resolveTaskProjectRunContext({ db, config = {}, task, runSnapshot = null }) {
  const projectIdSource = runSnapshot && "project_id" in runSnapshot
    ? runSnapshot.project_id
    : task?.project_id;
  const projectRow = projectIdSource ? resolveProjectRow(db, projectIdSource) : null;
  const project = projectFromRow(projectRow);
  const fallbackWorkdir = project?.workdir || config.workspace || config.repoRoot || process.cwd();
  const effectiveWorkdir = runSnapshot?.workdir || fallbackWorkdir;
  return {
    project,
    effectiveWorkdir,
    projectContextHash: projectContextHash(project),
  };
}

export function loadRunSnapshot(db, runId) {
  if (!runId) return null;
  const row = db.prepare(
    "SELECT project_id, workdir, workspace_mode, source_workdir, worktree_json, project_context_hash, diagnostics_json FROM task_runs WHERE id = ?",
  ).get(runId);
  return row || null;
}
