import { randomUUID } from "node:crypto";

const V2_CLAIM_PATTERN = /^v2:[A-Za-z0-9-]{1,200}$/u;

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
