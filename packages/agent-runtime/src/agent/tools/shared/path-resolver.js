import { isAbsolute, resolve } from "node:path";
import { readToolRuntime } from "./runtime-context.js";

function configured() {
  const { workspace, repoRoot } = readToolRuntime();
  return { workspace, repoRoot };
}

export function workspaceRoot(workdir) {
  const { workspace, repoRoot } = configured();
  return resolve(workdir || workspace || repoRoot || process.cwd());
}

export function resolveToolPath(path, workdir) {
  if (!path || typeof path !== "string") return path;
  return resolve(isAbsolute(path) ? path : resolve(workspaceRoot(workdir), path));
}

function roots(workdir) {
  const { workspace, repoRoot } = configured();
  return [...new Set([
    workdir,
    workspace,
    repoRoot,
    process.cwd(),
    "/tmp",
  ].filter(Boolean).map((p) => resolve(p)))];
}

export function isPathAllowed(path, workdir) {
  const r = resolveToolPath(path, workdir);
  return roots(workdir).some((root) => r === root || r.startsWith(root + "/"));
}

function envRoots() {
  const { workspace, repoRoot } = configured();
  return [...new Set([
    workspace,
    repoRoot,
    process.cwd(),
    "/tmp",
  ].filter(Boolean).map((p) => resolve(p)))];
}

export function isWorkdirAllowed(workdir) {
  if (!workdir) return true;
  const r = resolve(workdir);
  return envRoots().some((root) => r === root || r.startsWith(root + "/"));
}
