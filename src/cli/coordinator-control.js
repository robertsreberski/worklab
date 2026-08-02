import { isIP } from "node:net";
import {
  coordinatorIncarnationDigest,
  coordinatorShutdownProof,
  readMcpToken,
  worklabBaseUrl,
} from "../core/process/index.js";

const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 1_000;

function normalizedHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function isLoopbackHost(hostname) {
  const value = normalizedHostname(hostname);
  if (value === "localhost" || value === "::1") return true;
  return isIP(value) === 4 && value.startsWith("127.");
}

export function coordinatorControlBaseUrl(config) {
  const url = new URL(worklabBaseUrl(config));
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password) {
    return null;
  }
  return url;
}

async function boundedFetch(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timeout.unref?.();
  try {
    return await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestCoordinatorShutdown({
  config,
  incarnation,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
} = {}) {
  const baseUrl = coordinatorControlBaseUrl(config);
  if (!baseUrl || !incarnation) return { status: "control_unavailable" };
  const url = new URL("/api/runtime/shutdown", baseUrl);
  try {
    const proof = coordinatorShutdownProof(readMcpToken(config.dataDir), incarnation);
    if (!proof) return { status: "control_unavailable" };
    const response = await boundedFetch(fetchImpl, url, {
      method: "POST",
      headers: {
        "x-worklab-coordinator-shutdown-proof": proof,
      },
    }, timeoutMs);
    if (response.status === 202) return { status: "accepted" };
    if (response.status === 409) return { status: "incarnation_mismatch" };
    if (response.status === 401 || response.status === 403) return { status: "unauthorized" };
    return { status: "control_unavailable" };
  } catch {
    return { status: "control_unavailable" };
  }
}

export async function readCoordinatorHealth({
  config,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
} = {}) {
  const baseUrl = coordinatorControlBaseUrl(config);
  if (!baseUrl) return { status: "control_unavailable", health: null };
  try {
    const response = await boundedFetch(fetchImpl, new URL("/api/health", baseUrl), {
      method: "GET",
    }, timeoutMs);
    if (!response.ok) return { status: "control_unavailable", health: null };
    return { status: "ok", health: await response.json() };
  } catch {
    return { status: "control_unavailable", health: null };
  }
}

export function coordinatorHealthMatchesClaim(health, claim) {
  return claim?.claimFormat === "v2"
    && Number(health?.pid) === claim.pid
    && health?.coordinator?.claim_format === "v2"
    && health?.coordinator?.incarnation_sha256 === coordinatorIncarnationDigest(claim.incarnation);
}
