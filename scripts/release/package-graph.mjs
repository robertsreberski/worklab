#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function workspacePatterns(rootManifest) {
  const workspaces = rootManifest.workspaces;
  if (Array.isArray(workspaces)) return workspaces;
  if (workspaces && Array.isArray(workspaces.packages)) return workspaces.packages;
  return [];
}

function expandWorkspacePattern(pattern) {
  const normalized = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized.endsWith("/*")) {
    const packagePath = path.join(REPO_ROOT, normalized, "package.json");
    return fs.existsSync(packagePath) ? [path.dirname(packagePath)] : [];
  }

  const parent = path.join(REPO_ROOT, normalized.slice(0, -2));
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "package.json")));
}

function packageRecord(dir, packageJson, location) {
  return {
    dir,
    relativeDir: path.relative(REPO_ROOT, dir) || ".",
    manifestPath: path.join(dir, "package.json"),
    location,
    name: packageJson.name,
    version: packageJson.version,
    private: Boolean(packageJson.private),
    publishConfig: packageJson.publishConfig || null,
    packageJson,
  };
}

export function discoverPackages() {
  const rootManifestPath = path.join(REPO_ROOT, "package.json");
  const rootManifest = readJson(rootManifestPath);
  const packages = [packageRecord(REPO_ROOT, rootManifest, "root")];
  const seenDirs = new Set([REPO_ROOT]);

  for (const pattern of workspacePatterns(rootManifest)) {
    for (const dir of expandWorkspacePattern(pattern)) {
      const resolved = path.resolve(dir);
      if (seenDirs.has(resolved)) continue;
      seenDirs.add(resolved);
      packages.push(packageRecord(resolved, readJson(path.join(resolved, "package.json")), "workspace"));
    }
  }

  return packages;
}

export function isPublishablePackage(pkg) {
  return Boolean(pkg.name && !pkg.private && pkg.publishConfig);
}

export function publishablePackages(packages = discoverPackages()) {
  const names = new Set();
  const publishable = packages.filter(isPublishablePackage);
  for (const pkg of publishable) {
    if (names.has(pkg.name)) throw new Error(`duplicate publishable package name: ${pkg.name}`);
    names.add(pkg.name);
  }
  return publishable;
}

export function internalDependencies(pkg, packagesByName) {
  const deps = [];
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, range] of Object.entries(pkg.packageJson[section] || {})) {
      if (packagesByName.has(name)) deps.push({ section, name, range, package: packagesByName.get(name) });
    }
  }
  return deps;
}

export function sortForPublish(packages) {
  const rootPackage = packages.find((pkg) => pkg.location === "root");
  const workspacePackages = packages
    .filter((pkg) => pkg.location !== "root")
    .sort((a, b) => a.name.localeCompare(b.name));
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const visited = new Set();
  const visiting = new Set();
  const sorted = [];

  function visit(pkg) {
    if (visited.has(pkg.name)) return;
    if (visiting.has(pkg.name)) throw new Error(`cycle in publishable package dependencies at ${pkg.name}`);
    visiting.add(pkg.name);
    for (const dep of internalDependencies(pkg, packagesByName)) {
      if (dep.package.location !== "root") visit(dep.package);
    }
    visiting.delete(pkg.name);
    visited.add(pkg.name);
    sorted.push(pkg);
  }

  for (const pkg of workspacePackages) visit(pkg);
  if (rootPackage) sorted.push(rootPackage);
  return sorted;
}
