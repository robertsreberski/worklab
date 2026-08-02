import { domainToUnicode } from "node:url";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_URL_BYTES = 8 * 1024;
const MAX_IDENTIFIER_CHARS = 1_024;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;
const PUBLIC_URL_MESSAGE = "Continue in your browser.";

export const ACP_URL_PUBLIC_REQUEST = Object.freeze({
  mode: "url",
  message: PUBLIC_URL_MESSAGE,
  urlAvailable: true,
});

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

function safelyDecoded(value, { query = false } = {}) {
  try {
    return decodeURIComponent(query ? value.replace(/\+/gu, " ") : value);
  } catch {
    return null;
  }
}

function privateUrlValues(original, parsed) {
  const values = new Set([parsed.href]);
  if (original !== parsed.href) values.add(original);
  const addComponent = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    values.add(value);
  };

  addComponent(parsed.origin);
  addComponent(parsed.host);
  addComponent(parsed.hostname);
  addComponent(domainToUnicode(parsed.hostname));
  const authority = original.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/iu)?.[1] || "";
  if (authority && !authority.includes("@")) {
    addComponent(authority);
    addComponent(authority.replace(/:\d+$/u, ""));
  }

  if (parsed.pathname !== "/") {
    addComponent(parsed.pathname);
    addComponent(safelyDecoded(parsed.pathname));
    for (const segment of parsed.pathname.split("/")) {
      if (!segment) continue;
      addComponent(segment);
      addComponent(safelyDecoded(segment));
    }
  }
  for (const pair of parsed.search.slice(1).split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const serializedKey = separator < 0 ? pair : pair.slice(0, separator);
    addComponent(serializedKey);
    addComponent(safelyDecoded(serializedKey, { query: true }));
    if (separator >= 0) {
      const serializedValue = pair.slice(separator + 1);
      addComponent(serializedValue);
      addComponent(safelyDecoded(serializedValue, { query: true }));
    }
  }
  for (const key of parsed.searchParams.keys()) addComponent(key);
  for (const value of parsed.searchParams.values()) addComponent(value);
  if (parsed.hash.length > 1) {
    const serialized = parsed.hash.slice(1);
    addComponent(serialized);
    addComponent(safelyDecoded(serialized));
  }
  return [...values].sort((left, right) => right.length - left.length);
}

export function inspectAcpUrlHandoff(value, { maxBytes = DEFAULT_MAX_URL_BYTES } = {}) {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || CONTROL_CHAR_RE.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) return null;
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)
      || parsed.username
      || parsed.password
      || Buffer.byteLength(parsed.href, "utf8") > maxBytes) return null;
    return {
      url: parsed.href,
      privateValues: privateUrlValues(value, parsed),
    };
  } catch {
    return null;
  }
}

export function normalizeAcpUrlHandoff(value, options = {}) {
  return inspectAcpUrlHandoff(value, options)?.url ?? null;
}

export function createAcpUrlPublicRequest(value) {
  const inspected = inspectAcpUrlHandoff(value);
  return inspected ? { ...ACP_URL_PUBLIC_REQUEST } : null;
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
    const inspected = inspectAcpUrlHandoff(url, { maxBytes: safeMaxUrlBytes });
    if (!id || !owner || !inspected || entries.has(id)) return false;
    const bytes = Buffer.byteLength(
      `${id}\0${owner.ownerKind}\0${owner.ownerId}\0${owner.profileId}\0${inspected.url}`,
      "utf8",
    );
    if (entries.size >= safeMaxEntries || bytes > safeMaxBytes || retainedBytes + bytes > safeMaxBytes) {
      return false;
    }
    entries.set(id, {
      ...owner,
      url: inspected.url,
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

  function consumeWith(owner, consumer) {
    const entry = matchingEntry(owner);
    if (!entry) {
      scheduleExpiry();
      return { consumed: false, value: null };
    }
    const value = consumer(entry.url);
    removeEntry(owner.interactionId);
    scheduleExpiry();
    return { consumed: true, value };
  }

  function consume(owner) {
    return consumeWith(owner, (url) => url).value;
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
    consumeWith,
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
    get ttlMs() {
      return safeTtlMs;
    },
  };
}

export const ACP_URL_HANDOFF_LIMITS = Object.freeze({
  ttlMs: DEFAULT_TTL_MS,
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxBytes: DEFAULT_MAX_BYTES,
  maxUrlBytes: DEFAULT_MAX_URL_BYTES,
});
