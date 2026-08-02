const MAX_PERSISTED_JSON_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 2000;
const MAX_ITEMS = 200;
const MAX_DEPTH = 8;
const SENSITIVE_KEY_RE = /(?:secret|password|passphrase|token|api[_-]?key|credential|authorization|cookie|answer|form[_-]?values?)/iu;
const SCHEMA_VALUE_KEYS = new Set(["default", "const", "examples", "value", "values", "answer", "answers"]);

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

function sanitizedUrl(value) {
  const text = clippedText(value);
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
} = {}) {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return /(?:^|_)(?:url|uri|href)$/iu.test(parentKey) ? sanitizedUrl(value) : clippedText(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((entry) => sanitizedValue(entry, {
      depth: depth + 1,
      schema,
      parentKey,
    }));
  }
  if (!isPlainObject(value)) return null;
  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_ITEMS)) {
    const propertyIdentifier = parentKey === "properties";
    if (!propertyIdentifier && SENSITIVE_KEY_RE.test(key)) continue;
    if (schema && SCHEMA_VALUE_KEYS.has(key)) continue;
    const sanitized = sanitizedValue(entry, { depth: depth + 1, schema, parentKey: key });
    if (sanitized !== undefined) output[key] = sanitized;
  }
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

function sanitizeSession(value) {
  const session = picked(value, {
    id: ["id", "sessionId", "session_id"],
    title: ["title", "name", "label"],
    createdAt: ["createdAt", "created_at"],
    updatedAt: ["updatedAt", "updated_at"],
    status: "status",
  });
  if (session.id != null) session.id = clippedText(String(session.id), 500);
  if (session.title != null) session.title = clippedText(String(session.title), 500);
  if (session.status != null) session.status = clippedText(String(session.status), 100);
  return boundedObject(session);
}

export function sanitizeAcpOperationResult(kind, value) {
  const source = isPlainObject(value) ? value : {};
  if (kind === "authenticate" || kind === "logout") {
    return boundedObject(picked(source, {
      authenticated: "authenticated",
      status: "status",
      method: ["method", "authMethod", "auth_method"],
      warnings: "warnings",
    }));
  }
  if (kind === "list_sessions") {
    const sessions = Array.isArray(source.sessions) ? source.sessions.slice(0, MAX_ITEMS).map(sanitizeSession) : [];
    return boundedObject({ sessions, truncated: source.sessions?.length > sessions.length });
  }
  if (kind === "delete_session") {
    return boundedObject(picked(source, {
      deleted: "deleted",
      sessionId: ["sessionId", "session_id", "id"],
      status: "status",
    }));
  }
  return boundedObject(picked(source, {
    ok: "ok",
    status: "status",
    protocolVersion: ["protocolVersion", "protocol_version"],
    bridgeVersion: ["bridgeVersion", "bridge_version"],
    installedVersion: ["installedVersion", "installed_version"],
    latencyMs: ["latencyMs", "latency_ms"],
    authenticated: "authenticated",
    authRequired: ["authRequired", "auth_required"],
    capabilities: "capabilities",
    warnings: "warnings",
  }));
}

export function sanitizeAcpOperationError(kind, error, { cancelled = false } = {}) {
  const rawCode = clippedText(String(error?.code || (cancelled ? "cancelled" : "operation_failed")), 100);
  const code = /^[A-Za-z0-9_.-]+$/u.test(rawCode || "") ? rawCode : "operation_failed";
  const publicMessage = error?.publicMessage || error?.safeMessage;
  return {
    code,
    message: publicMessage
      ? clippedText(String(publicMessage), 500)
      : cancelled
        ? `ACP ${kind} operation was cancelled.`
        : `ACP ${kind} operation failed.`,
  };
}

export function sanitizeAcpInteractionSchema(value) {
  return boundedObject(value, { schema: true });
}

export function rowToAcpOperation(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    kind: row.kind,
    state: row.state,
    remoteSessionId: row.remote_session_id || null,
    request: parseJson(row.request_json, {}),
    result: parseJson(row.result_json, {}),
    error: parseJson(row.error_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
  };
}

export function rowToAcpInteraction(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    taskRunId: row.task_run_id || null,
    operationId: row.operation_id || null,
    protocolRequestId: row.protocol_request_id,
    kind: row.kind,
    requestSchema: parseJson(row.request_schema_json, {}),
    state: row.state,
    disposition: row.disposition || null,
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
    || nested.optionId
    || nested.option_id
    || nested.outcome
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
