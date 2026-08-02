import {
  readCoordinatorClaimFile,
  releaseCoordinatorLock,
  tryAcquireCoordinatorLock,
  unlinkCoordinatorClaimIfMatching,
} from "../core/process/index.js";

export function coordinatorProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function safeState(state, lease, retainLease) {
  if (retainLease) return { ...state, lease };
  releaseCoordinatorLock(lease);
  return state;
}

/**
 * Inspect the coordinator claim while using the SQLite lifetime lock as the
 * authority. When the lock is available, a v2 claim is stale even if its PID
 * has been reused by a live process. Legacy numeric-only claims predate the
 * lock and therefore retain their conservative process-liveness behavior.
 */
export function inspectCoordinatorStateOnce({ dataDir, retainLease = false } = {}) {
  const lease = tryAcquireCoordinatorLock(dataDir);
  if (lease.status === "busy") {
    const current = readCoordinatorClaimFile(dataDir);
    return {
      status: "ownership_busy",
      pid: current.parsed.pid,
      pidFile: current.pidFile,
      claim: current.claim,
      claimFormat: current.parsed.format,
      incarnation: current.parsed.incarnation || null,
    };
  }

  try {
    const current = readCoordinatorClaimFile(dataDir);
    if (current.parsed.format === "missing") {
      return safeState({
        status: "not_running",
        pid: null,
        pidFile: current.pidFile,
      }, lease, retainLease);
    }
    if (current.parsed.format === "legacy") {
      if (coordinatorProcessAlive(current.parsed.pid)) {
        releaseCoordinatorLock(lease);
        return {
          status: "running",
          pid: current.parsed.pid,
          pidFile: current.pidFile,
          claim: current.claim,
          claimFormat: "legacy",
        };
      }
      unlinkCoordinatorClaimIfMatching(lease, current.claim);
      return safeState({
        status: "stale_pid",
        pid: current.parsed.pid,
        pidFile: current.pidFile,
        claimFormat: "legacy",
      }, lease, retainLease);
    }

    // Acquiring the lifetime lock proves that a v2 incarnation is gone. Invalid
    // claim files are likewise safe to remove while the exact lock is held.
    unlinkCoordinatorClaimIfMatching(lease, current.claim);
    return safeState({
      status: "stale_pid",
      pid: current.parsed.pid,
      pidFile: current.pidFile,
      claimFormat: current.parsed.format,
    }, lease, retainLease);
  } catch (error) {
    releaseCoordinatorLock(lease);
    throw error;
  }
}

export function cleanupCoordinatorClaim(dataDir, expectedClaim) {
  const lease = tryAcquireCoordinatorLock(dataDir);
  if (lease.status === "busy") return false;
  try {
    return unlinkCoordinatorClaimIfMatching(lease, expectedClaim);
  } finally {
    releaseCoordinatorLock(lease);
  }
}
