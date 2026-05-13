#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEPENDENCY_SECTIONS,
  REPO_ROOT,
  discoverPackages,
  internalDependencies,
  publishablePackages,
  sortForPublish,
} from "./package-graph.mjs";

const TAG_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;

function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

export function releaseVersionFromTag(tag) {
  const match = TAG_RE.exec(tag || "");
  if (!match) {
    throw new Error(`release tag must look like v1.2.3 or v1.2.3-beta.1; received ${tag || "(missing)"}`);
  }
  return match[1];
}

function rel(filePath) {
  return path.relative(REPO_ROOT, filePath) || ".";
}

export function validateRelease({ tag = process.env.GITHUB_REF_NAME, silent = false } = {}) {
  const version = releaseVersionFromTag(tag);
  const packages = discoverPackages();
  const publishable = publishablePackages(packages);
  const publishOrder = sortForPublish(publishable);
  const packagesByName = new Map(publishable.map((pkg) => [pkg.name, pkg]));
  const issues = [];

  if (!publishable.length) issues.push("no publishable packages found");

  for (const pkg of publishable) {
    if (pkg.version !== version) {
      issues.push(`${pkg.name} version must be ${version}; found ${pkg.version} in ${rel(pkg.manifestPath)}`);
    }
  }

  for (const pkg of publishable) {
    for (const dep of internalDependencies(pkg, packagesByName)) {
      if (dep.range !== version) {
        issues.push(`${pkg.name} ${dep.section}.${dep.name} must be exactly ${version}; found ${dep.range}`);
      }
    }
  }

  const privateWorkspacesWithPublishConfig = packages
    .filter((pkg) => pkg.private && pkg.publishConfig)
    .map((pkg) => `${pkg.name || rel(pkg.manifestPath)} has publishConfig but is private`);
  issues.push(...privateWorkspacesWithPublishConfig);

  if (issues.length) {
    const error = new Error(`release validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    error.issues = issues;
    throw error;
  }

  if (!silent) {
    console.log(`Release ${tag} validates as version ${version}.`);
    console.log("Publish order:");
    for (const pkg of publishOrder) {
      console.log(`- ${pkg.name}@${pkg.version} (${pkg.relativeDir})`);
    }
    console.log(`Checked internal dependency sections: ${DEPENDENCY_SECTIONS.join(", ")}`);
  }

  return { tag, version, packages, publishablePackages: publishOrder };
}

async function main() {
  const tag = argValue("--tag") || process.env.GITHUB_REF_NAME;
  validateRelease({ tag });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
