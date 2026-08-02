import { createHash } from "node:crypto";

const MAX_PERSISTED_JSON_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 2000;
const MAX_ITEMS = 200;
const MAX_DEPTH = 8;
const MAX_AUTH_METHOD_ID_CHARS = 500;
const MAX_PROVIDER_SESSION_ID_CHARS = 5_600;
const MAX_SESSION_CURSOR_CHARS = 5_600;
const MAX_PRIVACY_SCAN_DEPTH = 20;
const MAX_PRIVACY_SCAN_NODES = 50_000;
const MAX_RAW_SESSION_IDS = 512;
const MAX_RAW_SESSION_ID_CHARS = 16 * 1024;
const MAX_PRIVACY_SCAN_STRING_CHARS = 4 * 1024 * 1024;
const PROVIDER_SESSION_ID_RE = /^acp:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z0-9_-]+)$/u;
const SESSION_CURSOR_RE = /^acp-cursor:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z0-9_-]+)$/u;
const RAW_SESSION_ID_KEYS = new Set([
  "sessionid",
  "rawsessionid",
  "remotesessionid",
]);
const PROVIDER_SESSION_ID_KEYS = new Set(["providersessionid"]);
const OPERATION_KINDS = new Set([
  "probe",
  "authenticate",
  "logout",
  "list_sessions",
  "delete_session",
]);
const SENSITIVE_KEY_RE = /(?:secret|password|passphrase|token|api[_-]?key|credential|authorization|cookie|answer|form[_-]?values?)/iu;
const SCHEMA_VALUE_KEYS = new Set([
  "default",
  "const",
  "examples",
  "value",
  "values",
  "content",
  "answer",
  "answers",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function clippedText(value, max = MAX_TEXT_CHARS) {
  if (typeof value !== "string") return null;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, max);
}

function normalizedPrivacyKey(value) {
  return String(value || "").replace(/[_-]/gu, "").toLowerCase();
}

function decodedOpaqueToken(encoded, { maxBytes = 4_096 } = {}) {
  try {
    const decoded = Buffer.from(encoded, "base64url");
    const value = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    if (decoded.length === 0
      || decoded.length > maxBytes
      || decoded.toString("base64url") !== encoded
      || !value
      || value.trim() !== value
      || value.includes("\0")) return null;
    return value;
  } catch {
    return null;
  }
}

function parsedProviderSessionId(value, profileId = null) {
  if (typeof value !== "string" || value.length > MAX_PROVIDER_SESSION_ID_CHARS) return null;
  const match = PROVIDER_SESSION_ID_RE.exec(value);
  if (!match || (profileId && match[1] !== profileId)) return null;
  const rawValue = decodedOpaqueToken(match[2]);
  return rawValue == null ? null : { profileId: match[1], rawValue, value };
}

function parsedSessionCursor(value, profileId = null) {
  if (typeof value !== "string" || value.length > MAX_SESSION_CURSOR_CHARS) return null;
  const match = SESSION_CURSOR_RE.exec(value);
  if (!match || (profileId && match[1] !== profileId)) return null;
  const rawValue = decodedOpaqueToken(match[2]);
  return rawValue == null ? null : { profileId: match[1], rawValue, value };
}

function canonicalProviderSessionId(value, profileId = null) {
  return parsedProviderSessionId(value, profileId)?.value ?? null;
}

function canonicalSessionCursor(value, profileId = null) {
  return parsedSessionCursor(value, profileId)?.value ?? null;
}

function privacyScan(value, additionalRawSessionIds = []) {
  const rawSessionIds = new Set();
  const rawCursorValues = new Set();
  const visited = new WeakSet();
  const state = { nodes: 0, stringChars: 0, complete: true };

  const collect = (collection, candidate) => {
    if (candidate == null || candidate === "") return;
    if (typeof candidate !== "string" || candidate.length > MAX_RAW_SESSION_ID_CHARS) {
      state.complete = false;
      return;
    }
    if (collection.has(candidate)) return;
    if (rawSessionIds.size + rawCursorValues.size >= MAX_RAW_SESSION_IDS) {
      state.complete = false;
      return;
    }
    collection.add(candidate);
  };
  const collectSession = (candidate) => collect(rawSessionIds, candidate);
  const collectCursor = (candidate) => collect(rawCursorValues, candidate);
  for (const candidate of additionalRawSessionIds) {
    const provider = parsedProviderSessionId(candidate);
    collectSession(provider?.rawValue ?? candidate);
  }

  const scan = (entry, depth = 0) => {
    if (!state.complete) return;
    if (depth > MAX_PRIVACY_SCAN_DEPTH) {
      state.complete = false;
      return;
    }
    state.nodes += 1;
    if (state.nodes > MAX_PRIVACY_SCAN_NODES) {
      state.complete = false;
      return;
    }
    if (typeof entry === "string") {
      state.stringChars += entry.length;
      if (state.stringChars > MAX_PRIVACY_SCAN_STRING_CHARS) state.complete = false;
      const provider = parsedProviderSessionId(entry);
      if (provider) collectSession(provider.rawValue);
      const cursor = parsedSessionCursor(entry);
      if (cursor) collectCursor(cursor.rawValue);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    if (visited.has(entry)) return;
    visited.add(entry);
    const values = Array.isArray(entry) ? entry.entries() : Object.entries(entry);
    for (const [rawKey, item] of values) {
      const key = Array.isArray(entry) ? "" : String(rawKey);
      state.stringChars += key.length;
      if (state.stringChars > MAX_PRIVACY_SCAN_STRING_CHARS) {
        state.complete = false;
        return;
      }
      const normalizedKey = normalizedPrivacyKey(key);
      if (RAW_SESSION_ID_KEYS.has(normalizedKey)) {
        const provider = parsedProviderSessionId(item);
        collectSession(provider?.rawValue ?? item);
      }
      if (PROVIDER_SESSION_ID_KEYS.has(normalizedKey)) {
        const provider = parsedProviderSessionId(item);
        collectSession(provider?.rawValue ?? item);
      }
      scan(item, depth + 1);
      if (!state.complete) return;
    }
  };
  scan(value);

  return {
    complete: state.complete,
    rawSessionIds: [...rawSessionIds].sort((left, right) => right.length - left.length),
    rawCursorValues: [...rawCursorValues].sort((left, right) => right.length - left.length),
    redactions: [...new Set([...rawSessionIds, ...rawCursorValues])]
      .sort((left, right) => right.length - left.length),
  };
}

function containsRawSessionId(value, rawSessionIds) {
  return typeof value === "string"
    && rawSessionIds.some((rawSessionId) => value.includes(rawSessionId));
}

function redactedText(value, rawSessionIds, max = MAX_TEXT_CHARS) {
  if (typeof value !== "string") return null;
  let result = value;
  for (const rawSessionId of rawSessionIds) {
    result = result.split(rawSessionId).join("[redacted]");
  }
  return clippedText(result, max);
}

function sanitizedUrl(value, rawSessionIds) {
  const text = redactedText(value, rawSessionIds);
  if (!text) return text;
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
    url.hash = "";
    return url.toString();
  } catch {
    return text.replace(/([?#]).*$/u, "$1[redacted]");
  }
}

function sanitizedValue(value, {
  depth = 0,
  schema = false,
  parentKey = "",
  rawSessionIds = [],
  ancestors = new WeakSet(),
} = {}) {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (canonicalProviderSessionId(value) || canonicalSessionCursor(value)) return value;
    return /(?:^|_)(?:url|uri|href)$/iu.test(parentKey)
      ? sanitizedUrl(value, rawSessionIds)
      : redactedText(value, rawSessionIds);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return null;
    ancestors.add(value);
    const result = value.slice(0, MAX_ITEMS).map((entry) => sanitizedValue(entry, {
      depth: depth + 1,
      schema,
      parentKey,
      rawSessionIds,
      ancestors,
    }));
    ancestors.delete(value);
    return result;
  }
  if (!isPlainObject(value)) return null;
  if (ancestors.has(value)) return null;
  ancestors.add(value);
  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_ITEMS)) {
    const propertyIdentifier = parentKey === "properties";
    const normalizedKey = normalizedPrivacyKey(key);
    if (RAW_SESSION_ID_KEYS.has(normalizedKey)) continue;
    if (PROVIDER_SESSION_ID_KEYS.has(normalizedKey)
      && !canonicalProviderSessionId(entry)) continue;
    if (containsRawSessionId(key, rawSessionIds)) continue;
    if (!propertyIdentifier && SENSITIVE_KEY_RE.test(key)) continue;
    if (schema && !propertyIdentifier && SCHEMA_VALUE_KEYS.has(key.toLowerCase())) continue;
    const sanitized = sanitizedValue(entry, {
      depth: depth + 1,
      schema,
      parentKey: key,
      rawSessionIds,
      ancestors,
    });
    if (sanitized !== undefined) output[key] = sanitized;
  }
  ancestors.delete(value);
  return output;
}

function boundedObject(value, options = {}) {
  const sanitized = sanitizedValue(isPlainObject(value) ? value : {}, options);
  const json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, "utf8") <= MAX_PERSISTED_JSON_BYTES) return sanitized;
  return { truncated: true };
}

function picked(value, keys) {
  if (!isPlainObject(value)) return {};
  const output = {};
  for (const [publicKey, aliases] of Object.entries(keys)) {
    const names = Array.isArray(aliases) ? aliases : [aliases];
    const found = names.find((name) => Object.hasOwn(value, name));
    if (found !== undefined) output[publicKey] = value[found];
  }
  return output;
}

function sanitizeSession(value, { profileId = null, rawSessionIds = [] } = {}) {
  const session = picked(value, {
    id: ["providerSessionId", "provider_session_id", "id"],
    title: ["title", "name", "label"],
    createdAt: ["createdAt", "created_at"],
    updatedAt: ["updatedAt", "updated_at"],
    status: "status",
  });
  try {
    session.id = normalizeAcpProviderSessionId(session.id, profileId);
  } catch {
    return null;
  }
  for (const [key, limit] of [["title", 500], ["status", 100]]) {
    if (session[key] == null) continue;
    const text = String(session[key]);
    if (containsRawSessionId(text, rawSessionIds) && rawSessionIds.includes(text)) {
      delete session[key];
      continue;
    }
    session[key] = redactedText(text, rawSessionIds, limit);
  }
  for (const key of ["createdAt", "updatedAt"]) {
    if (session[key] == null) continue;
    const text = clippedText(String(session[key]), 100);
    const parsed = text && !containsRawSessionId(text, rawSessionIds)
      ? Date.parse(text)
      : Number.NaN;
    if (!Number.isFinite(parsed)) {
      delete session[key];
      continue;
    }
    session[key] = new Date(parsed).toISOString();
  }
  return boundedObject(session, { rawSessionIds });
}

function boundedSessionListResult({ sessions, nextCursor, truncated }) {
  const result = {
    sessions: [],
    ...(nextCursor ? { nextCursor } : {}),
    truncated: Boolean(truncated),
  };
  for (const session of sessions) {
    result.sessions.push(session);
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_PERSISTED_JSON_BYTES) continue;
    result.sessions.pop();
    result.truncated = true;
    break;
  }
  if (result.sessions.length < sessions.length) result.truncated = true;
  return result;
}

function sanitizeAuthMethod(value) {
  const method = picked(value, {
    id: "id",
    name: "name",
    type: "type",
  });
  let id;
  try {
    id = normalizeAcpAuthMethodId(method.id);
  } catch {
    return null;
  }
  return {
    id,
    name: clippedText(String(method.name || id), 500)?.trim() || id,
    type: clippedText(String(method.type || "agent"), 100)?.trim() || "agent",
  };
}

export function normalizeAcpAuthMethodId(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error("authMethodId is required"), {
      code: "validation",
      status: 400,
      safeMessage: "authMethodId is required",
    });
  }
  if (value.trim() !== value
    || value.length > MAX_AUTH_METHOD_ID_CHARS
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error("authMethodId is invalid"), {
      code: "validation",
      status: 400,
      safeMessage: "authMethodId is invalid",
    });
  }
  return value;
}

export function normalizeAcpProviderSessionId(value, profileId = null) {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.length > MAX_PROVIDER_SESSION_ID_CHARS
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error("providerSessionId is invalid"), {
      code: "validation",
      status: 400,
      safeMessage: "providerSessionId is invalid",
    });
  }
  if (!parsedProviderSessionId(value, profileId)) {
    throw Object.assign(new Error("providerSessionId is invalid"), {
      code: "validation",
      status: 400,
      safeMessage: "providerSessionId is invalid",
    });
  }
  return value;
}

export function normalizeAcpSessionCursor(value, profileId = null) {
  if (value == null) return null;
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.length > MAX_SESSION_CURSOR_CHARS
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error("cursor is invalid"), {
      code: "validation",
      status: 400,
      safeMessage: "cursor is invalid",
    });
  }
  if ((profileId || value.startsWith("acp-cursor:"))
    && !parsedSessionCursor(value, profileId)) {
    throw Object.assign(new Error("cursor is invalid"), {
      code: "validation",
      status: 400,
      safeMessage: "cursor is invalid",
    });
  }
  return value;
}

function failedClosedOperationResult(kind, source, profileId) {
  if (kind === "list_sessions") return { sessions: [], truncated: true };
  if (kind === "delete_session") {
    const id = canonicalProviderSessionId(
      source?.providerSessionId ?? source?.provider_session_id ?? source?.id,
      profileId,
    );
    return {
      ...(typeof source?.deleted === "boolean" ? { deleted: source.deleted } : {}),
      ...(id ? { id } : {}),
      truncated: true,
    };
  }
  return { truncated: true };
}

export function sanitizeAcpOperationResult(kind, value, {
  profileId = null,
  rawSessionIds: additionalRawSessionIds = [],
} = {}) {
  const source = isPlainObject(value) ? value : {};
  const privacy = privacyScan(source, additionalRawSessionIds);
  if (!privacy.complete) return failedClosedOperationResult(kind, source, profileId);
  const { rawSessionIds, redactions } = privacy;
  if (kind === "authenticate" || kind === "logout") {
    return boundedObject(picked(source, {
      authenticated: "authenticated",
      status: "status",
      authMethodId: ["authMethodId", "methodId", "method", "authMethod", "auth_method"],
      warnings: "warnings",
      truncated: "truncated",
    }), { rawSessionIds: redactions });
  }
  if (kind === "list_sessions") {
    const candidates = Array.isArray(source.sessions) ? source.sessions.slice(0, MAX_ITEMS) : [];
    const sessions = candidates
      .map((session) => sanitizeSession(session, { profileId, rawSessionIds: redactions }))
      .filter(Boolean);
    const rawNextCursor = source.nextCursor ?? source.next_cursor ?? null;
    let nextCursor = null;
    if (!containsRawSessionId(rawNextCursor, rawSessionIds)) {
      try {
        nextCursor = normalizeAcpSessionCursor(rawNextCursor, profileId);
      } catch { /* omit an unusable remote cursor without corrupting it */ }
    }
    return boundedSessionListResult({
      sessions,
      nextCursor,
      truncated: Boolean(source.truncated)
        || source.sessions?.length > sessions.length
        || (typeof rawNextCursor === "string" && rawNextCursor.length > 0),
    });
  }
  if (kind === "delete_session") {
    const result = picked(source, {
      deleted: "deleted",
      id: ["providerSessionId", "provider_session_id", "id"],
      truncated: "truncated",
    });
    if (typeof result.deleted !== "boolean") delete result.deleted;
    if (result.id !== undefined) {
      try {
        result.id = normalizeAcpProviderSessionId(result.id, profileId);
      } catch {
        delete result.id;
      }
    }
    return boundedObject(result, { rawSessionIds: redactions });
  }
  const probe = picked(source, {
    ok: "ok",
    status: "status",
    protocolVersion: ["protocolVersion", "protocol_version"],
    bridgeVersion: ["bridgeVersion", "bridge_version"],
    installedVersion: ["installedVersion", "installed_version"],
    latencyMs: ["latencyMs", "latency_ms"],
    authenticated: "authenticated",
    capabilities: "capabilities",
    warnings: "warnings",
    truncated: "truncated",
  });
  if (Array.isArray(source.authMethods)) {
    const seen = new Set();
    probe.authMethods = source.authMethods.slice(0, MAX_ITEMS).flatMap((value) => {
      const method = sanitizeAuthMethod(value);
      if (!method || seen.has(method.id)) return [];
      seen.add(method.id);
      return [method];
    });
  }
  return boundedObject(probe, { rawSessionIds: redactions });
}

export function sanitizeAcpOperationError(kind, error, {
  cancelled = false,
  rawSessionIds = [],
} = {}) {
  const privacy = privacyScan(error, rawSessionIds);
  const rawCode = clippedText(String(error?.code || (cancelled ? "cancelled" : "operation_failed")), 100);
  const code = privacy.complete
    && /^[A-Za-z0-9_.-]+$/u.test(rawCode || "")
    && !containsRawSessionId(rawCode, privacy.redactions)
    ? rawCode
    : "operation_failed";
  const operation = OPERATION_KINDS.has(kind) ? kind : "operation";
  const message = code === "coordinator_restarted"
    ? "Worklab restarted before the ACP operation completed."
    : code === "operation_timeout" || code === "timeout"
      ? `ACP ${operation} operation timed out.`
      : cancelled || code === "cancelled"
        ? `ACP ${operation} operation was cancelled.`
        : `ACP ${operation} operation failed.`;
  return {
    code,
    message,
  };
}

function safeProtocolRequestId(value, rawSessionIds, { complete = true } = {}) {
  const original = typeof value === "string" ? value : String(value ?? "");
  const clipped = clippedText(original, 500)?.trim() || "";
  if (complete
    && clipped === original
    && clipped.length > 0
    && !containsRawSessionId(clipped, rawSessionIds)) {
    return clipped;
  }
  const digest = createHash("sha256").update(original).digest("base64url").slice(0, 32);
  return `acp-request:v1:${digest}`;
}

export function sanitizeAcpInteractionRequest({
  source,
  protocolRequestId,
  requestSchema,
  rawSessionIds: additionalRawSessionIds = [],
} = {}) {
  const privacy = privacyScan(source ?? requestSchema, additionalRawSessionIds);
  return {
    protocolRequestId: safeProtocolRequestId(protocolRequestId, privacy.redactions, privacy),
    requestSchema: privacy.complete && isPlainObject(requestSchema)
      ? boundedObject(requestSchema, { schema: true, rawSessionIds: privacy.redactions })
      : { truncated: true },
  };
}

export function sanitizeAcpInteractionSchema(value, options = {}) {
  return sanitizeAcpInteractionRequest({
    source: options.source ?? value,
    protocolRequestId: "schema-only",
    requestSchema: value,
    rawSessionIds: options.rawSessionIds,
  }).requestSchema;
}

function sanitizeStoredOperationRequest(kind, request, {
  profileId,
  remoteSessionId,
  redactions,
  complete,
} = {}) {
  if (!complete) return {};
  if (kind === "authenticate") {
    try {
      const authMethodId = normalizeAcpAuthMethodId(
        request?.authMethodId ?? request?.auth_method_id,
      );
      return containsRawSessionId(authMethodId, redactions) ? {} : { authMethodId };
    } catch {
      return {};
    }
  }
  if (kind === "list_sessions") {
    const candidate = request?.cursor;
    if (!canonicalSessionCursor(candidate, profileId)
      && containsRawSessionId(candidate, redactions)) return {};
    try {
      const cursor = normalizeAcpSessionCursor(candidate, profileId);
      return cursor ? { cursor } : {};
    } catch {
      return {};
    }
  }
  if (kind === "delete_session") {
    const candidate = request?.providerSessionId
      ?? request?.provider_session_id
      ?? remoteSessionId;
    const providerSessionId = canonicalProviderSessionId(candidate, profileId);
    return providerSessionId ? { providerSessionId } : {};
  }
  return {};
}

export function rowToAcpOperation(row) {
  if (!row) return null;
  const request = parseJson(row.request_json, {});
  const result = parseJson(row.result_json, {});
  const error = parseJson(row.error_json, {});
  const privacy = privacyScan({
    remoteSessionId: row.remote_session_id,
    request,
    result,
    error,
  });
  const remoteSessionId = canonicalProviderSessionId(row.remote_session_id, row.profile_id);
  return {
    id: row.id,
    profileId: row.profile_id,
    kind: row.kind,
    state: row.state,
    remoteSessionId,
    request: sanitizeStoredOperationRequest(row.kind, request, {
      profileId: row.profile_id,
      remoteSessionId,
      redactions: privacy.redactions,
      complete: privacy.complete,
    }),
    result: privacy.complete
      ? sanitizeAcpOperationResult(row.kind, result, {
        profileId: row.profile_id,
        rawSessionIds: privacy.redactions,
      })
      : failedClosedOperationResult(row.kind, result, row.profile_id),
    error: isPlainObject(error) && Object.keys(error).length > 0
      ? sanitizeAcpOperationError(row.kind, error, {
        cancelled: row.state === "cancelled",
        rawSessionIds: privacy.redactions,
      })
      : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
  };
}

export function rowToAcpInteraction(row) {
  if (!row) return null;
  const requestSchema = parseJson(row.request_schema_json, {});
  const safeRequest = sanitizeAcpInteractionRequest({
    source: {
      protocolRequestId: row.protocol_request_id,
      requestSchema,
    },
    protocolRequestId: row.protocol_request_id,
    requestSchema,
  });
  const disposition = new Set([
    "accept",
    "decline",
    "cancel",
    "selected",
    "allow_once",
    "allow_always",
    "reject_once",
    "reject_always",
    "operation_ended",
    "run_ended",
  ]).has(row.disposition) ? row.disposition : null;
  return {
    id: row.id,
    profileId: row.profile_id,
    taskRunId: row.task_run_id || null,
    operationId: row.operation_id || null,
    protocolRequestId: safeRequest.protocolRequestId,
    kind: row.kind,
    requestSchema: safeRequest.requestSchema,
    state: row.state,
    disposition,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at || null,
  };
}

export function acpInteractionDisposition(interaction, response, explicit = null) {
  const source = isPlainObject(response) ? response : {};
  const nested = isPlainObject(source.outcome) ? source.outcome : {};
  let value = explicit
    || source.disposition
    || source.action
    || source.selection
    || nested.outcome
    || nested.optionId
    || nested.option_id
    || source.outcome;
  value = String(value || "").trim().toLowerCase();
  const aliases = {
    accepted: "accept",
    declined: "decline",
    cancelled: "cancel",
    canceled: "cancel",
    approved: "allow_once",
    denied: "reject_once",
  };
  value = aliases[value] || value;
  const allowed = interaction?.kind === "permission"
    ? new Set(["selected", "cancel", "allow_once", "allow_always", "reject_once", "reject_always"])
    : new Set(["accept", "decline", "cancel"]);
  if (!allowed.has(value)) {
    throw Object.assign(new Error(`invalid ${interaction?.kind || "ACP"} interaction disposition`), {
      code: "validation",
      status: 400,
      safeMessage: `invalid ${interaction?.kind || "ACP"} interaction disposition`,
    });
  }
  return value;
}
