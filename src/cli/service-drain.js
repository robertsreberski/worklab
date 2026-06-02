import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_POLL_MS = 250;
const DRAIN_SHUTDOWN_SLACK_MS = 10_000;
const MAX_DRAIN_TIMEOUT_MS = 10 * 60_000 + DRAIN_SHUTDOWN_SLACK_MS;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function coordinatorPidFile(config = {}) {
  return config?.dataDir ? join(config.dataDir, ".coordinator.pid") : null;
}

export function gracefulStopTimeoutMs(config = {}) {
  const drainTimeoutMs = Number(config?.drainTimeoutMs);
  const base = Number.isFinite(drainTimeoutMs) && drainTimeoutMs >= 0 ? drainTimeoutMs : 60_000;
  return Math.min(base + DRAIN_SHUTDOWN_SLACK_MS, MAX_DRAIN_TIMEOUT_MS);
}

function parsePid(value) {
  const pid = Number(String(value || "").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readPid(pidFile) {
  if (!pidFile || !existsSync(pidFile)) return { status: "not_running", pidFile };
  let pid = null;
  try {
    pid = parsePid(readFileSync(pidFile, "utf8"));
  } catch {
    pid = null;
  }
  if (!pid) {
    try { unlinkSync(pidFile); } catch {}
    return { status: "stale_pid", pid: null, pidFile };
  }
  return { status: "running", pid, pidFile };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "EPERM") return true;
    if (err?.code === "ESRCH") return false;
    return false;
  }
}

function unlinkMatchingPidFile(pidFile, pid) {
  if (!pidFile || !existsSync(pidFile)) return;
  try {
    const current = parsePid(readFileSync(pidFile, "utf8"));
    if (!current || current === pid) unlinkSync(pidFile);
  } catch {
    try { unlinkSync(pidFile); } catch {}
  }
}

async function waitForExit({ pid, pidFile, timeoutMs, pollMs }) {
  const startedAt = Date.now();
  for (;;) {
    if (!processAlive(pid)) {
      unlinkMatchingPidFile(pidFile, pid);
      return { status: "exited", pid, pidFile, elapsedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { status: "timed_out", pid, pidFile, elapsedMs: Date.now() - startedAt };
    }
    await delay(Math.max(1, Math.min(pollMs, timeoutMs - (Date.now() - startedAt))));
  }
}

export async function gracefulStopCoordinator({
  config = {},
  timeoutMs = gracefulStopTimeoutMs(config),
  pollMs = DEFAULT_POLL_MS,
  signal = "SIGTERM",
} = {}) {
  const pidFile = coordinatorPidFile(config);
  const current = readPid(pidFile);
  if (current.status !== "running") return current;
  if (!processAlive(current.pid)) {
    unlinkMatchingPidFile(pidFile, current.pid);
    return { status: "stale_pid", pid: current.pid, pidFile };
  }
  try {
    process.kill(current.pid, signal);
  } catch (err) {
    if (err?.code === "ESRCH") {
      unlinkMatchingPidFile(pidFile, current.pid);
      return { status: "stale_pid", pid: current.pid, pidFile };
    }
    throw err;
  }
  return waitForExit({
    pid: current.pid,
    pidFile,
    timeoutMs: Math.max(0, Number(timeoutMs) || 0),
    pollMs: Math.max(1, Number(pollMs) || DEFAULT_POLL_MS),
  });
}
