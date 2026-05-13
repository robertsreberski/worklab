import { startCoordinator } from "../coordinator.js";
import { execFileSync } from "node:child_process";
import { loadConfig, worklabBaseUrl } from "../core/index.js";
import { ensureServiceInstalled, startUserService } from "./install-service.js";
import { applyConfigArgs, hasFlag } from "./args.js";
import { assertServiceRuntimeReady, serviceErrorLogTail } from "./service-runtime.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function buildUi(config = loadConfig()) {
  execFileSync("npm", ["run", "build:ui"], {
    cwd: config.repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      WORKLAB_DATA_DIR: config.dataDir,
      WORKLAB_HOST: config.host,
      WORKLAB_PORT: String(config.port),
    },
  });
}

function hasUiBuildInputs(config) {
  return existsSync(join(config.repoRoot, "src", "ui", "src"))
    && existsSync(join(config.repoRoot, "src", "ui", "vite.config.js"));
}

function hasBundledUi(config) {
  return existsSync(join(config.repoRoot, "src", "ui", "dist", "index.html"));
}

export function ensureUiReady(
  config = loadConfig(),
  { skipBuild = false, build = buildUi, log = console.log } = {},
) {
  if (skipBuild) {
    log("build: skipped");
    return { action: "skip", reason: "flag" };
  }
  if (hasUiBuildInputs(config)) {
    build(config);
    return { action: "build", reason: "source-ui" };
  }
  if (hasBundledUi(config)) {
    log("build: skipped (using bundled UI)");
    return { action: "skip", reason: "bundled-ui" };
  }
  throw new Error("Worklab UI assets are missing. In a source checkout, run `npm run build:ui`. In an npm install, reinstall @worklab-ai/worklab because the package is missing src/ui/dist.");
}

export async function waitForHealth(config = loadConfig(), { timeoutMs = 15000 } = {}) {
  const started = Date.now();
  const url = `${worklabBaseUrl(config)}/api/health`;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const tail = serviceErrorLogTail(config);
  throw new Error(`Worklab service did not become healthy at ${url}: ${lastError?.message || "timeout"}${tail ? `\nRecent service stderr:\n${tail}` : ""}`);
}

export function restartHealthTimeoutMs(config = loadConfig()) {
  const drainTimeoutMs = Number(config?.drainTimeoutMs);
  const replacementSlackMs = 30_000;
  if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs <= 0) return replacementSlackMs;
  return Math.min(drainTimeoutMs + replacementSlackMs, 10 * 60_000 + replacementSlackMs);
}

export async function serve(args = []) {
  applyConfigArgs(args);
  const config = loadConfig();
  await startCoordinator({ config });
  // keep process alive
}

export async function start(args = []) {
  applyConfigArgs(args);
  const config = loadConfig();
  ensureUiReady(config, { skipBuild: hasFlag(args, "--no-build") });
  const installed = await ensureServiceInstalled({ config });
  assertServiceRuntimeReady(config);
  await startUserService({ config });
  const health = await waitForHealth(config);
  console.log(`worklab: running at ${worklabBaseUrl(config)} (${installed.file})`);
  return health;
}
