import { isAbsolute, resolve } from "node:path";

export function workspaceRoot(workdir) {
  return resolve(workdir || process.env.WORKLAB_WORKSPACE || process.env.WORKLAB_REPO_ROOT || process.cwd());
}

export function resolveToolPath(path, workdir) {
  if (!path || typeof path !== "string") return path;
  return resolve(isAbsolute(path) ? path : resolve(workspaceRoot(workdir), path));
}

function roots(workdir) {
  return [...new Set([
    workdir,
    process.env.WORKLAB_WORKSPACE,
    process.env.WORKLAB_REPO_ROOT,
    process.cwd(),
    "/tmp",
  ].filter(Boolean).map((p) => resolve(p)))];
}

export function isPathAllowed(path, workdir) {
  const r = resolveToolPath(path, workdir);
  return roots(workdir).some((root) => r === root || r.startsWith(root + "/"));
}

function envRoots() {
  return [...new Set([
    process.env.WORKLAB_WORKSPACE,
    process.env.WORKLAB_REPO_ROOT,
    process.cwd(),
    "/tmp",
  ].filter(Boolean).map((p) => resolve(p)))];
}

export function isWorkdirAllowed(workdir) {
  if (!workdir) return true;
  const r = resolve(workdir);
  return envRoots().some((root) => r === root || r.startsWith(root + "/"));
}
