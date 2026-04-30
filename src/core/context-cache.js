import { createHash } from "node:crypto";

// Lightweight in-process LRU keyed by a deterministic context signature.
// Used by the run-input layer to skip re-rendering the system prompt for
// task/agent combinations that haven't changed since the last run. The
// cache is per-process; the API server, the coordinator, and each worker
// each get their own instance via createContextCache().
export function createContextCache({ maxEntries = 256 } = {}) {
  const map = new Map();
  let hits = 0;
  let misses = 0;

  function get(key) {
    if (!map.has(key)) {
      misses += 1;
      return null;
    }
    const value = map.get(key);
    map.delete(key);
    map.set(key, value);
    hits += 1;
    return value;
  }

  function set(key, value) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  }

  function invalidate(prefix) {
    if (!prefix) return;
    for (const key of [...map.keys()]) {
      if (key.startsWith(prefix)) map.delete(key);
    }
  }

  function stats() {
    return { hits, misses, size: map.size };
  }

  function clear() {
    map.clear();
    hits = 0;
    misses = 0;
  }

  return { get, set, invalidate, clear, stats };
}

const PROCESS_CACHE = createContextCache();

export function getProcessContextCache() {
  return PROCESS_CACHE;
}

// Build a stable cache key from inputs whose change should bust the cache.
// Anything not in this signature is assumed to be invariant within the
// (taskId, agentName, mode, lastRunId) tuple. Adapter-driven flags
// (like effort) and skill content are folded in via the contributing hashes
// the caller passes in.
export function makeContextCacheKey({
  taskId,
  agentName,
  mode,
  priorRunId = "",
  agentUpdatedAt = 0,
  taskUpdatedAt = 0,
  projectId = "",
  projectUpdatedAt = 0,
  projectWorkdirHash = "",
  projectContextHash = "",
  commentsHash = "",
  skillsHash = "",
  mcpHash = "",
  builtinHash = "",
  kbHash = "",
  artifactsHash = "",
  memoryHash = "",
  journalHash = "",
  capabilitiesHash = "",
}) {
  const parts = [
    taskId || "",
    agentName || "",
    mode || "",
    priorRunId || "",
    String(agentUpdatedAt || 0),
    String(taskUpdatedAt || 0),
    projectId || "",
    String(projectUpdatedAt || 0),
    projectWorkdirHash || "",
    projectContextHash || "",
    commentsHash, skillsHash, mcpHash, builtinHash,
    kbHash, artifactsHash, memoryHash, journalHash, capabilitiesHash,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

export function shortHash(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}
