import { appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import {
  getUpdateStatus,
  loadConfig,
  readPackageMetadata,
  readUpdateState,
  updateLogPath,
  writeUpdateState,
} from "../core/index.js";
import { restart } from "./restart.js";

function argValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseUpdateArgs(args = []) {
  const parsed = { apply: false, json: false, refresh: false, version: "" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      parsed.apply = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--refresh") {
      parsed.refresh = true;
    } else if (arg === "--version") {
      parsed.version = argValue(args, i, "--version");
      i++;
    } else if (arg.startsWith("--version=")) {
      parsed.version = arg.slice("--version=".length);
    } else {
      throw new Error(`unknown update option: ${arg}`);
    }
  }
  if (parsed.apply && !parsed.version) throw new Error("--version is required with --apply");
  return parsed;
}

export function buildNpmInstallArgs({ npmCli, packageName, version }) {
  return [npmCli, "install", "-g", `${packageName}@${version}`];
}

function isoNow(now = Date.now) {
  const value = typeof now === "function" ? now() : now;
  return new Date(Number(value)).toISOString();
}

function appendUpdateLog(dataDir, message) {
  const path = updateLogPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${message.replace(/\n*$/, "")}\n`, "utf8");
  return path;
}

export async function runPackageUpdate({
  config,
  version,
  status,
  nodePath = process.execPath,
  execFileSyncImpl = execFileSync,
  restartImpl = restart,
  now = Date.now,
} = {}) {
  const state = readUpdateState(config.dataDir);
  const pkg = status?.package?.name
    ? { name: status.package.name }
    : readPackageMetadata(config.repoRoot);
  const npmCli = status?.install?.npm_cli;
  if (!npmCli) throw new Error("npm CLI path is unavailable for this Worklab install");
  const logPath = appendUpdateLog(config.dataDir, `[${isoNow(now)}] installing ${pkg.name}@${version}`);
  const runningJob = {
    status: "running",
    target_version: version,
    started_at: isoNow(now),
    log_path: logPath,
  };
  writeUpdateState(config.dataDir, { ...state, job: runningJob });
  try {
    const output = execFileSyncImpl(nodePath, buildNpmInstallArgs({ npmCli, packageName: pkg.name, version }), {
      cwd: config.repoRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (output) appendUpdateLog(config.dataDir, output);
    await restartImpl(["--no-build"]);
    writeUpdateState(config.dataDir, {
      ...readUpdateState(config.dataDir),
      job: {
        ...runningJob,
        status: "succeeded",
        finished_at: isoNow(now),
      },
    });
  } catch (err) {
    appendUpdateLog(config.dataDir, err?.stderr ? String(err.stderr) : err.message);
    writeUpdateState(config.dataDir, {
      ...readUpdateState(config.dataDir),
      job: {
        ...runningJob,
        status: "failed",
        finished_at: isoNow(now),
        error: err.message,
      },
    });
    throw err;
  }
}

function formatStatus(update) {
  const current = update.package?.current_version || "-";
  const latest = update.package?.latest_version || "-";
  if (update.update_available) return `worklab: update available ${current} -> ${latest}`;
  if (update.status === "local_newer") return `worklab: local version ${current} is newer than npm latest ${latest}`;
  if (update.status === "current") return `worklab: current (${current})`;
  return `worklab: update status unknown${update.error ? `: ${update.error}` : ""}`;
}

export async function update(args = []) {
  const parsed = parseUpdateArgs(args);
  const config = loadConfig();
  if (parsed.apply) {
    const status = await getUpdateStatus({ config, refresh: true, execFileSyncImpl: execFileSync });
    if (!status.install?.supported) throw new Error("one-click updates require a global npm package install");
    if (!status.update_available) throw new Error("no npm update is available");
    if (parsed.version !== status.package?.latest_version) throw new Error("version must match the latest npm version");
    await runPackageUpdate({ config, version: parsed.version, status });
    return;
  }

  const status = await getUpdateStatus({ config, refresh: parsed.refresh, execFileSyncImpl: execFileSync });
  if (parsed.json) {
    console.log(JSON.stringify({ update: status }, null, 2));
    return;
  }
  console.log(formatStatus(status));
}
