#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./package-graph.mjs";
import { validateRelease } from "./validate-release.mjs";

function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function cleanRegistryEnv() {
  return {
    ...process.env,
    NPM_CONFIG_USERCONFIG: "/dev/null",
  };
}

function packageVersionExists(pkg) {
  const result = spawnSync(
    "npm",
    ["view", `${pkg.name}@${pkg.version}`, "version", "--json", "--registry", "https://registry.npmjs.org/"],
    { cwd: REPO_ROOT, encoding: "utf8", env: cleanRegistryEnv() },
  );
  if (result.status === 0) return true;

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (output.includes("E404") || output.includes("404 Not Found") || output.includes("could not be found")) {
    return false;
  }
  throw new Error(`npm view failed for ${pkg.name}@${pkg.version}:\n${output.trim()}`);
}

function runNpm(args, { dryRun = false } = {}) {
  const displayArgs = dryRun ? [...args, "--dry-run"] : args;
  console.log(`$ npm ${displayArgs.join(" ")}`);
  const result = spawnSync("npm", displayArgs, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function publishArgs(pkg) {
  const access = pkg.publishConfig?.access || "public";
  if (pkg.location === "workspace") {
    return ["publish", "--workspace", pkg.relativeDir, "--access", access];
  }
  return ["publish", "--access", access];
}

async function main() {
  const tag = argValue("--tag") || process.env.GITHUB_REF_NAME;
  const dryRun = hasArg("--dry-run");
  const { publishablePackages } = validateRelease({ tag, silent: true });

  if (!dryRun && !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN) {
    throw new Error("NODE_AUTH_TOKEN or NPM_TOKEN is required to publish");
  }

  for (const pkg of publishablePackages) {
    if (packageVersionExists(pkg)) {
      console.log(`${pkg.name}@${pkg.version} already exists on npm; skipping.`);
      continue;
    }
    runNpm(publishArgs(pkg), { dryRun });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
