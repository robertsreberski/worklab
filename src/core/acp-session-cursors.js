export const ACP_SESSION_CURSOR_PREFIX = "acp-cursor:v2:";
export const MAX_ACP_CURSOR_TOKEN_BYTES = 4_096;
export const MAX_ACP_CURSOR_PROFILE_ID_CHARS = 128;

const ACP_TOKEN_NONCE_BYTES = 12;
const ACP_TOKEN_AUTH_TAG_BYTES = 16;
const MAX_SEALED_CURSOR_BYTES = ACP_TOKEN_NONCE_BYTES
  + MAX_ACP_CURSOR_TOKEN_BYTES
  + ACP_TOKEN_AUTH_TAG_BYTES;
const MAX_BASE64URL_CURSOR_CHARS = Math.ceil((MAX_SEALED_CURSOR_BYTES * 4) / 3);

export const MAX_ACP_SESSION_CURSOR_CHARS = ACP_SESSION_CURSOR_PREFIX.length
  + MAX_ACP_CURSOR_PROFILE_ID_CHARS
  + 1
  + MAX_BASE64URL_CURSOR_CHARS;

const ACP_SESSION_CURSOR_RE = /^acp-cursor:v2:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z0-9_-]+)$/u;

export const ACP_PAGINATION_CURSOR_PRIORITY = Object.freeze([
  "nextcursor",
  "cursor",
  "nextpagecursor",
  "pagecursor",
  "paginationcursor",
  "continuationcursor",
  "endcursor",
  "nextpagetoken",
  "pagetoken",
  "nextcontinuationtoken",
  "continuationtoken",
  "nexttoken",
]);

const ACP_PAGINATION_CURSOR_KEYS = new Set(ACP_PAGINATION_CURSOR_PRIORITY);

/**
 * Normalize every supported ACP pagination key spelling to one internal form.
 * The protocol adapters have historically emitted camelCase, snake_case, and
 * kebab-case aliases, so privacy consumers must share this exact vocabulary.
 */
export function normalizeAcpPaginationCursorKey(value) {
  const normalized = String(value || "").replace(/[_-]/gu, "").toLowerCase();
  return ACP_PAGINATION_CURSOR_KEYS.has(normalized) ? normalized : null;
}

/** Return every own pagination field. Callers must scan the complete array
 * before selecting one value so unselected aliases can still be redacted. */
export function acpPaginationCursorEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const normalizedKey = normalizeAcpPaginationCursorKey(key);
    return normalizedKey ? [{ key, normalizedKey, value: entry }] : [];
  });
}

export function selectAcpPaginationCursorEntry(value) {
  const candidates = acpPaginationCursorEntries(value);
  for (const normalizedKey of ACP_PAGINATION_CURSOR_PRIORITY) {
    const selected = candidates.find((candidate) => candidate.normalizedKey === normalizedKey);
    if (selected) return selected;
  }
  return null;
}

export function parseAcpSessionCursor(value, profileId = null) {
  if (typeof value !== "string" || value.length > MAX_ACP_SESSION_CURSOR_CHARS) return null;
  const match = ACP_SESSION_CURSOR_RE.exec(value);
  if (!match || (profileId && match[1] !== profileId)) return null;
  try {
    const sealed = Buffer.from(match[2], "base64url");
    if (sealed.length <= ACP_TOKEN_NONCE_BYTES + ACP_TOKEN_AUTH_TAG_BYTES
      || sealed.length > MAX_SEALED_CURSOR_BYTES
      || sealed.toString("base64url") !== match[2]) return null;
    return { profileId: match[1], value };
  } catch {
    return null;
  }
}
