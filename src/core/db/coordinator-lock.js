import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

function closeLockDb(lockDb) {
  try {
    if (lockDb?.inTransaction) lockDb.exec("ROLLBACK");
  } finally {
    try { lockDb?.close(); } catch {}
  }
}

/**
 * Try to acquire Worklab's lifetime coordinator lock without waiting.
 *
 * A successful lease proves that no v2 coordinator currently owns this data
 * directory. Callers that mutate the PID claim must keep the lease until the
 * exact compare-and-unlink has completed, otherwise a replacement coordinator
 * could publish its claim between those two operations.
 */
export function tryAcquireCoordinatorLock(dataDir) {
  const lockFile = join(dataDir, ".coordinator.lock");
  const lockDb = new Database(lockFile, { timeout: 0 });
  lockDb.pragma("busy_timeout = 0");
  try {
    lockDb.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    closeLockDb(lockDb);
    if (error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED") {
      return { status: "busy", dataDir, lockFile };
    }
    throw error;
  }
  return {
    status: "acquired",
    dataDir,
    lockFile,
    lockDb,
    released: false,
  };
}

export function releaseCoordinatorLock(lease) {
  if (!lease || lease.status !== "acquired" || lease.released) return;
  lease.released = true;
  closeLockDb(lease.lockDb);
}

export function unlinkCoordinatorClaimIfMatching(lease, expectedClaim) {
  if (!lease || lease.status !== "acquired" || lease.released) {
    throw new Error("an active coordinator lock lease is required to clean a PID claim");
  }
  if (expectedClaim === null || expectedClaim === undefined) return false;
  const pidFile = join(lease.dataDir, ".coordinator.pid");
  try {
    if (readFileSync(pidFile, "utf8") !== expectedClaim) return false;
    unlinkSync(pidFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
