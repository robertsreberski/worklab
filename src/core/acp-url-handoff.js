const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_URL_BYTES = 8 * 1024;
const MAX_IDENTIFIER_CHARS = 1_024;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

// This symbol is deliberately non-global. The ACP control adapter attaches the
// raw URL with Object.defineProperty(), so normal enumeration, serialization,
// logging, and public sanitizers cannot observe it.
export const ACP_PRIVATE_URL_HANDOFF = Symbol("worklab.acp.privateUrlHandoff");

function exactIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_CHARS
    && !CONTROL_CHAR_RE.test(value)
    ? value
    : null;
}

export function normalizeAcpUrlHandoff(value, { maxBytes = DEFAULT_MAX_URL_BYTES } = {}) {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || CONTROL_CHAR_RE.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) return null;
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)
      || parsed.username
      || parsed.password) return null;
    return value;
  } catch {
    return null;
  }
}

function normalizedOwner({ ownerKind, ownerId, profileId } = {}) {
  if (!new Set(["operation", "run"]).has(ownerKind)) return null;
  const id = exactIdentifier(ownerId);
  const profile = exactIdentifier(profileId);
  return id && profile ? { ownerKind, ownerId: id, profileId: profile } : null;
}

/**
 * Process-local, one-use storage for ACP URL elicitations.
 *
 * Raw URLs never enter SQLite or the event broker. Entries are synchronously
 * consumed, owner-bound, byte/count bounded, and removed by one shared expiry
 * timer rather than one timer per request.
 */
export function createAcpUrlHandoffStore({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  maxUrlBytes = DEFAULT_MAX_URL_BYTES,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const entries = new Map();
  let retainedBytes = 0;
  let expiryTimer = null;

  const safeTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.trunc(ttlMs) : DEFAULT_TTL_MS;
  const safeMaxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
  const safeMaxBytes = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const safeMaxUrlBytes = Number.isInteger(maxUrlBytes) && maxUrlBytes > 0
    ? maxUrlBytes
    : DEFAULT_MAX_URL_BYTES;

  function removeEntry(interactionId) {
    const entry = entries.get(interactionId);
    if (!entry) return false;
    entries.delete(interactionId);
    retainedBytes = Math.max(0, retainedBytes - entry.bytes);
    return true;
  }

  function purgeExpired(at = now()) {
    for (const [interactionId, entry] of entries) {
      if (entry.expiresAt <= at) removeEntry(interactionId);
    }
  }

  function scheduleExpiry() {
    if (expiryTimer) clearTimeoutFn(expiryTimer);
    expiryTimer = null;
    let nextExpiry = Infinity;
    for (const entry of entries.values()) nextExpiry = Math.min(nextExpiry, entry.expiresAt);
    if (!Number.isFinite(nextExpiry)) return;
    expiryTimer = setTimeoutFn(() => {
      expiryTimer = null;
      purgeExpired();
      scheduleExpiry();
    }, Math.max(1, nextExpiry - now()));
    expiryTimer?.unref?.();
  }

  function retain({ interactionId, ownerKind, ownerId, profileId, url } = {}) {
    purgeExpired();
    const id = exactIdentifier(interactionId);
    const owner = normalizedOwner({ ownerKind, ownerId, profileId });
    const normalizedUrl = normalizeAcpUrlHandoff(url, { maxBytes: safeMaxUrlBytes });
    if (!id || !owner || !normalizedUrl || entries.has(id)) return false;
    const bytes = Buffer.byteLength(
      `${id}\0${owner.ownerKind}\0${owner.ownerId}\0${owner.profileId}\0${normalizedUrl}`,
      "utf8",
    );
    if (entries.size >= safeMaxEntries || bytes > safeMaxBytes || retainedBytes + bytes > safeMaxBytes) {
      return false;
    }
    entries.set(id, {
      ...owner,
      url: normalizedUrl,
      bytes,
      expiresAt: now() + safeTtlMs,
    });
    retainedBytes += bytes;
    scheduleExpiry();
    return true;
  }

  function matchingEntry({ interactionId, ownerKind, ownerId, profileId } = {}) {
    purgeExpired();
    const entry = entries.get(interactionId);
    if (!entry
      || entry.ownerKind !== ownerKind
      || entry.ownerId !== ownerId
      || entry.profileId !== profileId) return null;
    return entry;
  }

  function has(owner) {
    return Boolean(matchingEntry(owner));
  }

  function consume(owner) {
    const entry = matchingEntry(owner);
    if (!entry) {
      scheduleExpiry();
      return null;
    }
    removeEntry(owner.interactionId);
    scheduleExpiry();
    return entry.url;
  }

  function remove(interactionId, owner = null) {
    purgeExpired();
    if (owner && !matchingEntry({ interactionId, ...owner })) return false;
    const removed = removeEntry(interactionId);
    scheduleExpiry();
    return removed;
  }

  function removeOwner(ownerKind, ownerId) {
    let removed = 0;
    for (const [interactionId, entry] of entries) {
      if (entry.ownerKind !== ownerKind || entry.ownerId !== ownerId) continue;
      if (removeEntry(interactionId)) removed += 1;
    }
    scheduleExpiry();
    return removed;
  }

  function clear() {
    if (expiryTimer) clearTimeoutFn(expiryTimer);
    expiryTimer = null;
    entries.clear();
    retainedBytes = 0;
  }

  return {
    available: true,
    retain,
    has,
    consume,
    remove,
    removeOwner,
    clear,
    get size() {
      purgeExpired();
      return entries.size;
    },
    get retainedBytes() {
      purgeExpired();
      return retainedBytes;
    },
  };
}

export const ACP_URL_HANDOFF_LIMITS = Object.freeze({
  ttlMs: DEFAULT_TTL_MS,
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxBytes: DEFAULT_MAX_BYTES,
  maxUrlBytes: DEFAULT_MAX_URL_BYTES,
});
