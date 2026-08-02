import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const V2_CLAIM_PATTERN = /^v2:[A-Za-z0-9-]{1,200}$/u;
const COORDINATOR_LOCK_FILE = ".coordinator.lock";
const COORDINATOR_PID_FILE = ".coordinator.pid";

export function parseCoordinatorPid(value) {
  const [firstLine = ""] = String(value ?? "").split(/\r?\n/u, 1);
  const normalized = firstLine.trim();
  if (!/^[1-9]\d*$/u.test(normalized)) return null;
  const pid = Number(normalized);
  return Number.isSafeInteger(pid) ? pid : null;
}

export function parseCoordinatorClaim(value) {
  const normalized = String(value ?? "").trim();
  const pid = parseCoordinatorPid(normalized);
  if (!pid) return { format: "invalid", pid: null };
  const lines = normalized.split(/\r?\n/u);
  if (lines.length === 1) return { format: "legacy", pid };
  if (lines.length === 2 && V2_CLAIM_PATTERN.test(lines[1])) {
    return { format: "v2", pid, incarnation: lines[1].slice(3) };
  }
  return { format: "invalid", pid };
}

export function createCoordinatorClaim(pid, incarnation = randomUUID()) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("coordinator pid must be a positive integer");
  if (!/^[A-Za-z0-9-]{1,200}$/u.test(incarnation)) throw new TypeError("coordinator incarnation is invalid");
  return `${pid}\nv2:${incarnation}`;
}

export function coordinatorIncarnationDigest(incarnation) {
  if (typeof incarnation !== "string" || !V2_CLAIM_PATTERN.test(`v2:${incarnation}`)) return null;
  return createHash("sha256").update(incarnation, "utf8").digest("hex");
}

export function coordinatorShutdownProof(serviceToken, incarnation) {
  if (typeof serviceToken !== "string" || serviceToken.length === 0) return null;
  if (typeof incarnation !== "string" || !V2_CLAIM_PATTERN.test(`v2:${incarnation}`)) return null;
  return createHmac("sha256", serviceToken)
    .update(`worklab-shutdown-v1:${incarnation}`, "utf8")
    .digest("hex");
}

export function coordinatorClaimPaths(dataDir) {
  return {
    lockFile: join(dataDir, COORDINATOR_LOCK_FILE),
    pidFile: join(dataDir, COORDINATOR_PID_FILE),
  };
}

export function readCoordinatorClaimFile(dataDir) {
  const { pidFile } = coordinatorClaimPaths(dataDir);
  try {
    const claim = readFileSync(pidFile, "utf8");
    return { pidFile, claim, parsed: parseCoordinatorClaim(claim) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { pidFile, claim: null, parsed: { format: "missing", pid: null } };
    }
    throw error;
  }
}
