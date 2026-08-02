import { normalizeAcpProviderSessionId } from "./acp-operations.js";

const MAX_ACP_EVENT_DEPTH = 20;
const MAX_ACP_EVENT_NODES = 50_000;
const MAX_ACP_EVENT_STRING_CHARS = 4 * 1024 * 1024;
const MAX_ACP_RAW_SESSION_IDS = 128;
const MAX_ACP_RAW_SESSION_ID_CHARS = 16 * 1024;
const ACP_SESSION_ID_KEYS = new Set(["sessionId", "session_id"]);
const ACP_PROVIDER_SESSION_ID_KEYS = new Set(["providerSessionId", "provider_session_id"]);

/**
 * Accept only the canonical opaque ID emitted for the expected ACP profile.
 * normalizeAcpProviderSessionId enforces the public envelope; the base64url
 * round trip rejects decoder-tolerated aliases and empty payloads.
 */
export function validateAcpProviderSessionId(value, profileId) {
  if (typeof profileId !== "string" || profileId.length === 0) return null;
  let normalized;
  try {
    normalized = normalizeAcpProviderSessionId(value, profileId);
  } catch {
    return null;
  }
  const prefix = `acp:v1:${profileId}:`;
  const encoded = normalized.slice(prefix.length);
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.length === 0 || decoded.toString("base64url") !== encoded) return null;
  } catch {
    return null;
  }
  return normalized;
}

/**
 * Stateful privacy boundary for ACP events. Each event is scanned before it
 * is copied, so identifiers discovered later in an object redact strings that
 * appeared earlier in the same event. Session-id keys are always removed;
 * provider-session keys survive only with a canonical profile-bound opaque ID.
 *
 * Once an event exceeds a traversal or identifier budget, the boundary stays
 * failed closed for the rest of the stream. Otherwise an identifier omitted
 * by the failed scan could leak from a later event.
 */
export function createAcpEventPrivacyBoundary({ profileId, failureValue = null } = {}) {
  const active = typeof profileId === "string" && profileId.length > 0;
  const rawSessionIds = new Set();
  let failedClosed = false;

  function failedValue(value) {
    return typeof failureValue === "function" ? failureValue(value) : failureValue;
  }

  function collectRawSessionId(value, collected) {
    if (value == null || value === "") return true;
    if (typeof value !== "string") return false;
    if (value.length > MAX_ACP_RAW_SESSION_ID_CHARS) return false;
    if (rawSessionIds.has(value) || collected.has(value)) return true;
    if (rawSessionIds.size + collected.size >= MAX_ACP_RAW_SESSION_IDS) return false;
    collected.add(value);
    return true;
  }

  function scan(value, state, collected, depth = 0) {
    if (depth > MAX_ACP_EVENT_DEPTH) return false;
    state.nodes += 1;
    if (state.nodes > MAX_ACP_EVENT_NODES) return false;
    if (typeof value === "string") {
      state.stringChars += value.length;
      return state.stringChars <= MAX_ACP_EVENT_STRING_CHARS;
    }
    if (value == null || typeof value !== "object") return true;
    if (Array.isArray(value)) {
      return value.every((entry) => scan(entry, state, collected, depth + 1));
    }
    for (const [key, entry] of Object.entries(value)) {
      state.stringChars += key.length;
      if (state.stringChars > MAX_ACP_EVENT_STRING_CHARS) return false;
      if (ACP_SESSION_ID_KEYS.has(key)) {
        if (!collectRawSessionId(entry, collected)) return false;
        continue;
      }
      if (ACP_PROVIDER_SESSION_ID_KEYS.has(key)) {
        if (!validateAcpProviderSessionId(entry, profileId)
          && !collectRawSessionId(entry, collected)) return false;
      }
      if (!scan(entry, state, collected, depth + 1)) return false;
    }
    return true;
  }

  function redactText(value) {
    if (failedClosed) return "[redacted]";
    let result = String(value ?? "");
    const ordered = [...rawSessionIds].sort((a, b) => b.length - a.length);
    for (const rawSessionId of ordered) {
      result = result.split(rawSessionId).join("[redacted]");
    }
    return result;
  }

  function copySanitized(value, depth = 0) {
    if (depth > MAX_ACP_EVENT_DEPTH) return null;
    if (typeof value === "string") return redactText(value);
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value)) return value.map((entry) => copySanitized(entry, depth + 1));
    if (typeof value !== "object") return null;
    const output = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (ACP_SESSION_ID_KEYS.has(key)) continue;
      if (ACP_PROVIDER_SESSION_ID_KEYS.has(key)) {
        const providerSessionId = validateAcpProviderSessionId(entry, profileId);
        if (providerSessionId) output[key] = providerSessionId;
        continue;
      }
      output[redactText(key)] = copySanitized(entry, depth + 1);
    }
    return output;
  }

  function sanitizeEvent(event) {
    if (!active) return event;
    if (failedClosed) return failedValue(event);
    const collected = new Set();
    const scanned = scan(event, { nodes: 0, stringChars: 0 }, collected);
    if (!scanned) {
      failedClosed = true;
      rawSessionIds.clear();
      return failedValue(event);
    }
    for (const value of collected) rawSessionIds.add(value);
    return copySanitized(event);
  }

  return {
    sanitizeEvent,
    redactText: active ? redactText : (value) => String(value ?? ""),
    validateProviderSessionId: (value) => validateAcpProviderSessionId(value, profileId),
    get failedClosed() { return failedClosed; },
  };
}
