import { join } from "node:path";
import {
  cleanupCoordinatorClaim,
  coordinatorProcessAlive,
  inspectCoordinatorStateOnce,
} from "./coordinator-state.js";
import {
  coordinatorControlBaseUrl,
  coordinatorHealthMatchesClaim,
  readCoordinatorHealth,
  requestCoordinatorShutdown,
} from "./coordinator-control.js";

const DEFAULT_POLL_MS = 250;
const DEFAULT_CONTROL_SETTLE_MS = 1_000;
const DEFAULT_CONTROL_RETRY_MS = 20;
const DRAIN_SHUTDOWN_SLACK_MS = 10_000;
const MAX_DRAIN_TIMEOUT_MS = 10 * 60_000 + DRAIN_SHUTDOWN_SLACK_MS;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function coordinatorPidFile(config = {}) {
  return config?.dataDir ? join(config.dataDir, ".coordinator.pid") : null;
}

export function gracefulStopTimeoutMs(config = {}) {
  const drainTimeoutMs = Number(config?.drainTimeoutMs);
  const base = Number.isFinite(drainTimeoutMs) && drainTimeoutMs >= 0 ? drainTimeoutMs : 60_000;
  return Math.min(base + DRAIN_SHUTDOWN_SLACK_MS, MAX_DRAIN_TIMEOUT_MS);
}

export function coordinatorStopComplete(result) {
  return new Set(["exited", "not_running", "stale_pid"]).has(result?.status);
}

export async function waitForCoordinatorRelease({
  config = {},
  timeoutMs = gracefulStopTimeoutMs(config),
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  if (!config?.dataDir) return { status: "not_running", pid: null, pidFile: null };
  const startedAt = Date.now();
  for (;;) {
    const state = inspectCoordinatorStateOnce({ dataDir: config.dataDir });
    if (state.status !== "ownership_busy" && state.status !== "running") return state;
    if (Date.now() - startedAt >= timeoutMs) {
      return { ...state, status: "timed_out", elapsedMs: Date.now() - startedAt };
    }
    await delay(Math.max(1, Math.min(pollMs, timeoutMs - (Date.now() - startedAt))));
  }
}

async function waitForLegacyExit({ dataDir, pid, pidFile, claim, timeoutMs, pollMs }) {
  const startedAt = Date.now();
  for (;;) {
    if (!coordinatorProcessAlive(pid)) {
      cleanupCoordinatorClaim(dataDir, claim);
      return { status: "exited", pid, pidFile, elapsedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { status: "timed_out", pid, pidFile, elapsedMs: Date.now() - startedAt };
    }
    await delay(Math.max(1, Math.min(pollMs, timeoutMs - (Date.now() - startedAt))));
  }
}

async function waitForV2Release({ dataDir, current, timeoutMs, pollMs }) {
  const startedAt = Date.now();
  for (;;) {
    const state = inspectCoordinatorStateOnce({ dataDir });
    if (state.status !== "ownership_busy" || state.claim !== current.claim) {
      return {
        status: "exited",
        method: "control",
        pid: current.pid,
        pidFile: current.pidFile,
        elapsedMs: Date.now() - startedAt,
      };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return {
        status: "timed_out",
        method: "control",
        pid: current.pid,
        pidFile: current.pidFile,
        elapsedMs: Date.now() - startedAt,
      };
    }
    await delay(Math.max(1, Math.min(pollMs, timeoutMs - (Date.now() - startedAt))));
  }
}

async function stopV2Coordinator({
  config,
  initial,
  timeoutMs,
  pollMs,
  fetchImpl,
  controlSettleMs,
  controlRetryMs,
  controlRequestTimeoutMs,
}) {
  if (!coordinatorControlBaseUrl(config)) {
    return { ...initial, status: "control_unavailable", reason: "non_loopback_control_url" };
  }
  const settleStartedAt = Date.now();
  let current = initial;
  for (;;) {
    current = inspectCoordinatorStateOnce({ dataDir: config.dataDir });
    if (current.status !== "ownership_busy") return current;
    if (current.claimFormat === "v2") {
      const health = await readCoordinatorHealth({
        config,
        fetchImpl,
        timeoutMs: controlRequestTimeoutMs,
      });
      const rechecked = inspectCoordinatorStateOnce({ dataDir: config.dataDir });
      if (coordinatorHealthMatchesClaim(health.health, current)
        && rechecked.status === "ownership_busy"
        && rechecked.claim === current.claim) {
        const requested = await requestCoordinatorShutdown({
          config,
          incarnation: current.incarnation,
          fetchImpl,
          timeoutMs: controlRequestTimeoutMs,
        });
        if (requested.status === "accepted") {
          return waitForV2Release({
            dataDir: config.dataDir,
            current,
            timeoutMs,
            pollMs,
          });
        }
        if (requested.status === "unauthorized") {
          return { ...current, status: "control_unavailable", reason: "unauthorized" };
        }
      }
    }
    if (Date.now() - settleStartedAt >= controlSettleMs) {
      return { ...current, status: "control_unavailable", reason: "identity_unconfirmed" };
    }
    await delay(Math.max(1, controlRetryMs));
  }
}

export async function gracefulStopCoordinator({
  config = {},
  timeoutMs = gracefulStopTimeoutMs(config),
  pollMs = DEFAULT_POLL_MS,
  signal = "SIGTERM",
  fetchImpl = globalThis.fetch,
  controlSettleMs = DEFAULT_CONTROL_SETTLE_MS,
  controlRetryMs = DEFAULT_CONTROL_RETRY_MS,
  controlRequestTimeoutMs = 1_000,
} = {}) {
  if (!config?.dataDir) return { status: "not_running", pid: null, pidFile: null };
  const current = inspectCoordinatorStateOnce({ dataDir: config.dataDir });
  if (current.status === "ownership_busy") {
    return stopV2Coordinator({
      config,
      initial: current,
      timeoutMs: Math.max(0, Number(timeoutMs) || 0),
      pollMs: Math.max(1, Number(pollMs) || DEFAULT_POLL_MS),
      fetchImpl,
      controlSettleMs: Math.max(0, Number(controlSettleMs) || 0),
      controlRetryMs: Math.max(1, Number(controlRetryMs) || DEFAULT_CONTROL_RETRY_MS),
      controlRequestTimeoutMs: Math.max(1, Number(controlRequestTimeoutMs) || 1_000),
    });
  }
  if (current.status !== "running") return current;

  // Only numeric-only legacy coordinators reach this path. V2 coordinators
  // shut themselves down after authenticating the exact incarnation token, so
  // a stale/reused v2 PID is never selected as a signal target.
  if (!coordinatorProcessAlive(current.pid)) {
    cleanupCoordinatorClaim(config.dataDir, current.claim);
    return { status: "stale_pid", pid: current.pid, pidFile: current.pidFile };
  }
  try {
    process.kill(current.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") {
      cleanupCoordinatorClaim(config.dataDir, current.claim);
      return { status: "stale_pid", pid: current.pid, pidFile: current.pidFile };
    }
    throw error;
  }
  const result = await waitForLegacyExit({
    dataDir: config.dataDir,
    pid: current.pid,
    pidFile: current.pidFile,
    claim: current.claim,
    timeoutMs: Math.max(0, Number(timeoutMs) || 0),
    pollMs: Math.max(1, Number(pollMs) || DEFAULT_POLL_MS),
  });
  return { ...result, method: "signal" };
}
