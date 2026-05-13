#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "src/cli/index.js",
  "src/core/config.js",
  "src/coordinator.js",
  "src/worker.js",
  "src/ui/dist/index.html",
  "data-template/agents/_seed/planner.json",
  "skills/worklab/SKILL.md",
];

const FORBIDDEN_PREFIXES = [
  "docs/audits/",
  "examples/",
  "node_modules/",
  "packages/",
  "playwright-report/",
  "src/__tests__/",
  "src/ui/src/",
  "test-results/",
  "tmp/",
];

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

export function validatePackMetadata(pack) {
  const paths = new Set(pack.files?.map((file) => file.path) || []);
  const issues = [];
  if (pack.name !== "@worklab-ai/worklab") {
    issues.push(`unexpected package name: ${pack.name || "(missing)"}`);
  }
  for (const required of REQUIRED_FILES) {
    if (!paths.has(required)) issues.push(`missing required file: ${required}`);
  }
  for (const path of paths) {
    if (FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)) || path.includes("/__tests__/") || path.endsWith(".test.js")) {
      issues.push(`forbidden package path: ${path}`);
    }
  }
  return issues;
}

async function main() {
  const input = await readStdin();
  const metadata = JSON.parse(input);
  const pack = Array.isArray(metadata) ? metadata[0] : metadata;
  const issues = validatePackMetadata(pack);
  if (issues.length) {
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }
  console.log(`npm pack contents ok: ${pack.name}@${pack.version} (${pack.entryCount} files)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
