import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import semver from "semver";

export const DEFAULT_UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";

function nowMs(now = Date.now) {
  const value = typeof now === "function" ? now() : now;
  return Number(value);
}

function isoNow(now = Date.now) {
  return new Date(nowMs(now)).toISOString();
}

function readJsonFile(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function realpathOrResolve(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function hasSourceUiInputs(repoRoot) {
  return existsSync(join(repoRoot, "src", "ui", "src"))
    && existsSync(join(repoRoot, "src", "ui", "vite.config.js"));
}

function hasBundledUi(repoRoot) {
  return existsSync(join(repoRoot, "src", "ui", "dist", "index.html"));
}

export function updateStatePath(dataDir) {
  return join(dataDir, "update-state.json");
}

export function updateLogPath(dataDir) {
  return join(dataDir, "logs", "worklab-update.log");
}

export function readUpdateState(dataDir) {
  if (!dataDir) return {};
  return readJsonFile(updateStatePath(dataDir), {}) || {};
}

export function writeUpdateState(dataDir, state) {
  if (!dataDir) return state;
  const path = updateStatePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state || {}, null, 2)}\n`, "utf8");
  return state;
}

export function readPackageMetadata(repoRoot) {
  const path = join(repoRoot, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  return {
    name: pkg.name || "",
    version: pkg.version || "",
    path,
  };
}

export function comparePackageVersions(currentVersion, latestVersion) {
  if (!semver.valid(currentVersion) || !semver.valid(latestVersion)) {
    return { status: "unknown", update_available: false };
  }
  if (semver.gt(latestVersion, currentVersion)) {
    return { status: "update_available", update_available: true };
  }
  if (semver.lt(latestVersion, currentVersion)) {
    return { status: "local_newer", update_available: false };
  }
  return { status: "current", update_available: false };
}

function registryLatestUrl(packageName, registryUrl = DEFAULT_REGISTRY_URL) {
  return `${registryUrl.replace(/\/+$/, "")}/${String(packageName).replace("/", "%2F")}/latest`;
}

async function fetchLatestPackage({ packageName, fetchImpl = fetch, registryUrl = DEFAULT_REGISTRY_URL } = {}) {
  const url = registryLatestUrl(packageName, registryUrl);
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res?.ok) {
    throw new Error(`npm registry returned HTTP ${res?.status || 0}`);
  }
  const body = await res.json();
  const latestVersion = body?.version || body?.["dist-tags"]?.latest;
  if (!latestVersion) throw new Error("npm registry response did not include a latest version");
  return {
    name: body?.name || packageName,
    version: latestVersion,
    url,
  };
}

function resolveNpmCliPath(nodePath = process.execPath) {
  const prefix = resolve(dirname(nodePath), "..");
  const candidates = [
    join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(prefix, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

export function resolveInstallMode({
  repoRoot,
  packageName,
  nodePath = process.execPath,
  execFileSyncImpl,
} = {}) {
  if (!repoRoot) return { mode: "unknown", supported: false, reason: "repo_root_missing" };
  if (hasSourceUiInputs(repoRoot)) {
    return { mode: "source_checkout", supported: false, reason: "source_checkout" };
  }
  const npmCli = resolveNpmCliPath(nodePath);
  if (!npmCli) {
    return {
      mode: hasBundledUi(repoRoot) ? "package_install" : "unknown",
      supported: false,
      reason: "npm_cli_not_found",
    };
  }
  if (!execFileSyncImpl) {
    return {
      mode: hasBundledUi(repoRoot) ? "package_install" : "unknown",
      supported: false,
      reason: "npm_root_unavailable",
      npm_cli: npmCli,
    };
  }

  let globalRoot = "";
  try {
    globalRoot = String(execFileSyncImpl(nodePath, [npmCli, "root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
  } catch (err) {
    return {
      mode: hasBundledUi(repoRoot) ? "package_install" : "unknown",
      supported: false,
      reason: `npm_root_failed: ${err.message}`,
      npm_cli: npmCli,
    };
  }

  const packageRoot = join(globalRoot, ...String(packageName || "").split("/"));
  const repoReal = realpathOrResolve(repoRoot);
  const packageReal = realpathOrResolve(packageRoot);
  const globalReal = realpathOrResolve(globalRoot);
  if (repoReal === packageReal) {
    return {
      mode: "global_npm",
      supported: true,
      reason: "global_npm_package",
      package_root: packageRoot,
      global_root: globalRoot,
      npm_cli: npmCli,
    };
  }

  const inGlobalRoot = repoReal === globalReal || repoReal.startsWith(`${globalReal}${sep}`);
  return {
    mode: inGlobalRoot ? "package_global_mismatch" : (hasBundledUi(repoRoot) ? "package_install" : "unknown"),
    supported: false,
    reason: inGlobalRoot ? "package_root_mismatch" : "not_global_npm_package",
    package_root: packageRoot,
    global_root: globalRoot,
    npm_cli: npmCli,
  };
}

function cachedCheckValid(check, { packageName, currentVersion, now, cacheTtlMs }) {
  if (!check?.checked_at || !check?.package) return false;
  if (check.package.name !== packageName) return false;
  if (check.package.current_version !== currentVersion) return false;
  const checkedAt = Date.parse(check.checked_at);
  if (!Number.isFinite(checkedAt)) return false;
  return nowMs(now) - checkedAt < cacheTtlMs;
}

function statusPayload({ check, install, state, cacheHit = false, cacheTtlMs = DEFAULT_UPDATE_CACHE_TTL_MS }) {
  return {
    ...check,
    install,
    job: state?.job || null,
    cache: { hit: cacheHit, ttl_ms: cacheTtlMs },
  };
}

export async function getUpdateStatus({
  config,
  refresh = false,
  fetchImpl = fetch,
  execFileSyncImpl = execFileSync,
  now = Date.now,
  cacheTtlMs = DEFAULT_UPDATE_CACHE_TTL_MS,
  registryUrl = DEFAULT_REGISTRY_URL,
} = {}) {
  const pkg = readPackageMetadata(config.repoRoot);
  const state = readUpdateState(config.dataDir);
  const install = resolveInstallMode({
    repoRoot: config.repoRoot,
    packageName: pkg.name,
    nodePath: process.execPath,
    execFileSyncImpl,
  });

  if (!refresh && cachedCheckValid(state.check, {
    packageName: pkg.name,
    currentVersion: pkg.version,
    now,
    cacheTtlMs,
  })) {
    return statusPayload({ check: state.check, install, state, cacheHit: true, cacheTtlMs });
  }

  try {
    const latest = await fetchLatestPackage({ packageName: pkg.name, fetchImpl, registryUrl });
    const comparison = comparePackageVersions(pkg.version, latest.version);
    const check = {
      package: {
        name: pkg.name,
        current_version: pkg.version,
        latest_version: latest.version,
      },
      status: comparison.status,
      update_available: comparison.update_available,
      checked_at: isoNow(now),
      registry_url: latest.url,
    };
    writeUpdateState(config.dataDir, { ...state, check });
    return statusPayload({ check, install, state: { ...state, check }, cacheHit: false, cacheTtlMs });
  } catch (err) {
    const check = {
      package: {
        name: pkg.name,
        current_version: pkg.version,
        latest_version: state.check?.package?.latest_version || null,
      },
      status: "unknown",
      update_available: false,
      checked_at: isoNow(now),
      error: err.message,
    };
    writeUpdateState(config.dataDir, { ...state, check });
    return statusPayload({ check, install, state: { ...state, check }, cacheHit: false, cacheTtlMs });
  }
}

export function updateJobIsActive(job) {
  return job?.status === "queued" || job?.status === "running";
}

export function queueUpdateApply({
  config,
  version,
  nodePath = process.execPath,
  spawnImpl = spawn,
  now = Date.now,
} = {}) {
  const state = readUpdateState(config.dataDir);
  const cli = join(config.repoRoot, "src", "cli", "index.js");
  const env = {
    ...process.env,
    WORKLAB_DATA_DIR: config.dataDir,
    WORKLAB_HOST: config.host,
    WORKLAB_PORT: config.port == null ? undefined : String(config.port),
    WORKLAB_WORKSPACE: config.workspace,
    WORKLAB_LOG_LEVEL: config.logLevel,
    WORKLAB_TIMEZONE: config.timezone,
    WORKLAB_DRAIN_TIMEOUT_MS: config.drainTimeoutMs == null ? undefined : String(config.drainTimeoutMs),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null || value === "") delete env[key];
  }
  const child = spawnImpl(nodePath, [cli, "update", "--apply", "--version", version], {
    detached: true,
    stdio: "ignore",
    cwd: config.repoRoot,
    env,
  });
  child?.unref?.();
  const job = {
    status: "queued",
    target_version: version,
    pid: child?.pid || null,
    queued_at: isoNow(now),
  };
  writeUpdateState(config.dataDir, { ...state, job });
  return { queued: true, pid: job.pid, target_version: version };
}
