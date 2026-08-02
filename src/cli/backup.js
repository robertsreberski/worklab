import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  loadConfig,
  MAX_ACP_CURSOR_TOKEN_BYTES,
  normalizeAcpProviderSessionId,
  normalizeAcpPaginationCursorKey,
  openDb,
  parseAcpSessionCursor,
} from "../core/index.js";
import { classifyAcpSessionIdKey } from "../core/acp-operations.js";
import { ACP_URL_PUBLIC_REQUEST } from "../core/acp-url-handoff.js";
import { applyConfigArgs } from "./args.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_ARCHIVE_MODE = 0o600;

// These files are credential stores, cryptographic keys, or may contain
// arbitrary inline MCP credentials. They must be recreated after restoring a
// backup instead of being copied into a portable archive.
const SECRET_ROOT_FILES = new Set([
  ".env",
  ".provider-encryption-key",
  "auth.json",
  "mcp-token",
  "pi-auth.json",
  "push-vapid.json",
]);

const OMITTED_ROOT_ENTRIES = new Set([
  ...SECRET_ROOT_FILES,
  ".coordinator.pid",
  ".coordinator.lock",
  "config",
  "logs",
  "worklab.db",
]);

const WEBHOOK_RECONFIGURATION_MESSAGE = "Webhook credential omitted from backup; edit the automation to generate a new webhook ID.";
const ACP_URL_PUBLIC_REQUEST_JSON = JSON.stringify(ACP_URL_PUBLIC_REQUEST);
const ACP_INTERACTION_DISPOSITIONS = new Set([
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
]);
const MAX_ACP_SCRUB_DEPTH = 32;
const MAX_ACP_SCRUB_NODES = 10_000;
const MAX_ACP_JSON_CHARS = 16 * 1024 * 1024;
const ACP_SCRUB_FALLBACK = { redacted: true, reason: "ACP session data exceeded backup scrub limits" };
const ACP_CURSOR_SCRUB_FALLBACK = { redacted: true, reason: "ACP pagination cursor data was invalid" };
const LEGACY_V1_PROVIDER_SESSION_RE = /^acp:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z0-9_-]+)$/u;
const LEGACY_V1_SESSION_CURSOR_RE = /^acp-cursor:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z0-9_-]+)$/u;
const ACP_HANDLE_CANDIDATE_RE = /acp(?:-cursor)?:v[12]:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9_-]+/gu;
const TASK_JSON_DEFAULTS = new Map([
  ["goal_contract_json", {}],
  ["pending_actions_json", []],
  ["pending_questions_json", []],
  ["blocking_issues_json", []],
]);
const TASK_TEXT_COLUMNS = ["goal_status_reason", "stage_reason", "plan_body", "error_text"];

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

function canonicalV2AcpProviderSessionId(value) {
  try {
    return normalizeAcpProviderSessionId(value);
  } catch {
    return null;
  }
}

function parseLegacyV1Token(value, pattern) {
  if (typeof value !== "string") return null;
  const match = pattern.exec(value);
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[2], "base64url");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes.length > 0
      && bytes.length <= MAX_ACP_CURSOR_TOKEN_BYTES
      && bytes.toString("base64url") === match[2]
      && decoded
      && decoded.trim() === decoded
      && !decoded.includes("\0")
      ? { profileId: match[1], rawValue: decoded, value }
      : null;
  } catch {
    return null;
  }
}

function parseLegacyV1AcpSessionId(value) {
  return parseLegacyV1Token(value, LEGACY_V1_PROVIDER_SESSION_RE);
}

function parseLegacyV1AcpSessionCursor(value) {
  return parseLegacyV1Token(value, LEGACY_V1_SESSION_CURSOR_RE);
}

function invalidatedAcpHandle(value) {
  return canonicalV2AcpProviderSessionId(value)
    || parseAcpSessionCursor(value)?.value
    || parseLegacyV1AcpSessionId(value)?.value
    || parseLegacyV1AcpSessionCursor(value)?.value
    || null;
}

function addPrivateAcpIdentifier(values, value) {
  if (typeof value !== "string" || !value) return;
  if (canonicalV2AcpProviderSessionId(value)) return;
  const legacy = parseLegacyV1AcpSessionId(value);
  if (legacy) {
    values.add(legacy.rawValue);
    return;
  }
  values.add(value);
}

function canonicalAcpSessionCursor(value, profileId) {
  return parseAcpSessionCursor(value, profileId)?.value ?? null;
}

function legacyAcpSessionCursor(value) {
  return typeof value === "string"
    && !value.startsWith("acp-cursor:")
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_ACP_CURSOR_TOKEN_BYTES
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function parseJson(value) {
  try { return { ok: true, value: JSON.parse(value) }; } catch { return { ok: false, value: null }; }
}

function scrubTraversalState() {
  return { depth: 0, nodes: 0, seen: new WeakSet(), failed: false };
}

function enterScrubNode(value, state, depth) {
  state.nodes += 1;
  if (depth > MAX_ACP_SCRUB_DEPTH || state.nodes > MAX_ACP_SCRUB_NODES) {
    state.failed = true;
    return false;
  }
  if (value && typeof value === "object") {
    if (state.seen.has(value)) {
      state.failed = true;
      return false;
    }
    state.seen.add(value);
  }
  return true;
}

function collectAcpIdentifiers(value, values, {
  includeCursors = false,
  sessionRecord = false,
  parentKey = "",
  depth = 0,
  state = scrubTraversalState(),
} = {}) {
  if (!enterScrubNode(value, state, depth)) return state;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectAcpIdentifiers(entry, values, {
        includeCursors,
        sessionRecord: parentKey === "sessions",
        depth: depth + 1,
        state,
      });
      if (state.failed) break;
    }
    return state;
  }
  if (!value || typeof value !== "object") return state;
  for (const [key, entry] of Object.entries(value)) {
    if (classifyAcpSessionIdKey(key) || (sessionRecord && key === "id")) {
      addPrivateAcpIdentifier(values, entry);
    }
    if (includeCursors && normalizeAcpPaginationCursorKey(key)) {
      if (entry != null) {
        const legacy = parseLegacyV1AcpSessionCursor(entry);
        if (!parseAcpSessionCursor(entry)) {
          if (legacy) values.add(legacy.rawValue);
          else if (typeof entry === "string" && entry) values.add(entry);
          else state.failed = true;
        }
      }
    }
    collectAcpIdentifiers(entry, values, {
      includeCursors,
      parentKey: key,
      depth: depth + 1,
      state,
    });
    if (state.failed) break;
  }
  return state;
}

function collectJsonAcpIdentifiers(text, values, options = {}) {
  if (text == null) return true;
  const serialized = String(text || "");
  if (serialized.length > MAX_ACP_JSON_CHARS) return false;
  const pattern = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/gu;
  let matches = 0;
  for (const match of serialized.matchAll(pattern)) {
    try {
      const key = JSON.parse(`"${match[1]}"`);
      const value = JSON.parse(`"${match[2]}"`);
      if (classifyAcpSessionIdKey(key)) {
        addPrivateAcpIdentifier(values, value);
      }
      if (options.includeCursors && normalizeAcpPaginationCursorKey(key)) {
        const legacy = parseLegacyV1AcpSessionCursor(value);
        if (!parseAcpSessionCursor(value)) values.add(legacy?.rawValue ?? value);
      }
    } catch { /* ignore malformed strings; the containing value is replaced fail-closed */ }
    matches += 1;
    if (matches >= MAX_ACP_SCRUB_NODES) break;
  }
  const parsed = parseJson(text);
  if (parsed.ok) {
    return !collectAcpIdentifiers(parsed.value, values, options).failed;
  }
  return false;
}

function redactPrivateAcpText(value, privateValues) {
  if (typeof value !== "string" || !value) return value;
  let output = value.replace(ACP_HANDLE_CANDIDATE_RE, (candidate) => (
    invalidatedAcpHandle(candidate) ? "[redacted]" : candidate
  ));
  for (const identifier of [...privateValues].sort((a, b) => b.length - a.length)) {
    output = output.split(identifier).join("[redacted]");
  }
  return output;
}

function scrubAcpValue(value, privateValues, {
  includeCursors = false,
  sessionRecord = false,
  parentKey = "",
  depth = 0,
  state = scrubTraversalState(),
} = {}) {
  if (!enterScrubNode(value, state, depth)) return null;
  if (typeof value === "string") return redactPrivateAcpText(value, privateValues);
  if (Array.isArray(value)) {
    const output = [];
    for (const entry of value) {
      output.push(scrubAcpValue(entry, privateValues, {
        includeCursors,
        sessionRecord: parentKey === "sessions",
        depth: depth + 1,
        state,
      }));
      if (state.failed) break;
    }
    return output;
  }
  if (!value || typeof value !== "object") return value;
  const output = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (classifyAcpSessionIdKey(key)) continue;
    if (sessionRecord && key === "id") continue;
    if (includeCursors && normalizeAcpPaginationCursorKey(key)) continue;
    const outputKey = redactPrivateAcpText(key, privateValues);
    output[outputKey] = scrubAcpValue(entry, privateValues, {
      includeCursors,
      parentKey: key,
      depth: depth + 1,
      state,
    });
    if (state.failed) break;
  }
  return output;
}

function scrubAcpJson(text, privateValues, { forceFailure = false, includeCursors = false } = {}) {
  if (text == null) return text;
  if (forceFailure) return JSON.stringify(ACP_SCRUB_FALLBACK);
  if (String(text || "").length > MAX_ACP_JSON_CHARS) return JSON.stringify(ACP_SCRUB_FALLBACK);
  const parsed = parseJson(text);
  if (!parsed.ok) return JSON.stringify(ACP_SCRUB_FALLBACK);
  const state = scrubTraversalState();
  const scrubbed = scrubAcpValue(parsed.value, privateValues, { includeCursors, state });
  return JSON.stringify(state.failed ? ACP_SCRUB_FALLBACK : scrubbed);
}

function backupUrlProtocolRequestId(interactionId) {
  const digest = createHash("sha256").update(String(interactionId ?? "")).digest("hex").slice(0, 32);
  return `backup:url:${digest}`;
}

function validAcpCursorAliases(value, profileId, {
  depth = 0,
  state = scrubTraversalState(),
} = {}) {
  if (!enterScrubNode(value, state, depth)) return false;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!validAcpCursorAliases(entry, profileId, { depth: depth + 1, state })) return false;
    }
    return true;
  }
  if (!value || typeof value !== "object") return true;
  for (const [key, entry] of Object.entries(value)) {
    if (normalizeAcpPaginationCursorKey(key)
      && entry != null
      && !canonicalAcpSessionCursor(entry, profileId)
      && parseLegacyV1AcpSessionCursor(entry)?.profileId !== profileId
      && !legacyAcpSessionCursor(entry)) return false;
    if (!validAcpCursorAliases(entry, profileId, { depth: depth + 1, state })) return false;
  }
  return true;
}

function scrubAcpOperationJson(row, column, privateValues, { forceFailure = false } = {}) {
  if (forceFailure) return JSON.stringify(ACP_SCRUB_FALLBACK);
  if (row.kind !== "list_sessions") return scrubAcpJson(row[column], privateValues);
  if (row[column] == null) return row[column];
  if (String(row[column]).length > MAX_ACP_JSON_CHARS) return JSON.stringify(ACP_SCRUB_FALLBACK);
  const parsed = parseJson(row[column]);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return JSON.stringify(ACP_CURSOR_SCRUB_FALLBACK);
  }

  if (!validAcpCursorAliases(parsed.value, row.profile_id)) {
    return JSON.stringify(ACP_CURSOR_SCRUB_FALLBACK);
  }
  const state = scrubTraversalState();
  const scrubbed = scrubAcpValue(parsed.value, privateValues, {
    includeCursors: true,
    state,
  });
  if (state.failed) return JSON.stringify(ACP_SCRUB_FALLBACK);
  return JSON.stringify(scrubbed);
}

function updateJsonColumns(
  db,
  table,
  id,
  columns,
  row,
  privateValues,
  failedCells,
  { forceFailure = false } = {},
) {
  if (!columns.length) return;
  db.prepare(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
    .run(...columns.map((column) => scrubAcpJson(row[column], privateValues, {
      forceFailure: forceFailure || failedCells.has(`${table}:${id}:${column}`),
    })), id);
}

function referenceContainsEntity(value, ids) {
  return String(value || "").split(/[/:#]/u).some((segment) => ids.has(segment));
}

function globallyDistinctivePrivateValue(value) {
  if (value.length < 24) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u]
    .filter((pattern) => pattern.test(value)).length;
  return classes >= 3 || (value.length >= 32 && classes >= 2) || value.length >= 48;
}

function mergePrivateValues(target, values) {
  for (const value of values) target.add(value);
}

function ownershipEntries(scope, ownership) {
  return [
    ["profile", scope.byProfile, scope.failedProfiles, ownership.profileId],
    ["run", scope.byRun, scope.failedRuns, ownership.runId],
    ["task", scope.byTask, scope.failedTasks, ownership.taskId],
  ].filter(([, , , key]) => key);
}

function linkPrivateValueOwnership(scope, ownership) {
  if (ownershipEntries(scope, ownership).length > 1) scope.ownershipLinks.push(ownership);
}

function addOwnedPrivateValues(scope, values, ownership = {}) {
  const { profileId, runId, taskId } = ownership;
  mergePrivateValues(scope.all, values);
  for (const [map, key] of [
    [scope.byProfile, profileId],
    [scope.byRun, runId],
    [scope.byTask, taskId],
  ]) {
    if (!key) continue;
    if (!map.has(key)) map.set(key, new Set());
    mergePrivateValues(map.get(key), values);
  }
  linkPrivateValueOwnership(scope, ownership);
}

function markOwnedPrivateValueFailure(scope, ownership) {
  for (const [, , failures, key] of ownershipEntries(scope, ownership)) failures.add(key);
  linkPrivateValueOwnership(scope, ownership);
}

function propagatePrivateValueOwnership(scope) {
  const nodes = new Map();
  const neighbors = new Map();
  for (const ownership of scope.ownershipLinks) {
    const entries = ownershipEntries(scope, ownership).map(([type, map, failures, key]) => {
      const nodeId = JSON.stringify([type, key]);
      nodes.set(nodeId, { map, failures, key });
      if (!neighbors.has(nodeId)) neighbors.set(nodeId, new Set());
      return nodeId;
    });
    for (const nodeId of entries) {
      for (const neighbor of entries) {
        if (neighbor !== nodeId) neighbors.get(nodeId).add(neighbor);
      }
    }
  }

  const visited = new Set();
  for (const start of nodes.keys()) {
    if (visited.has(start)) continue;
    const component = [];
    const pending = [start];
    while (pending.length) {
      const nodeId = pending.pop();
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      component.push(nodeId);
      pending.push(...(neighbors.get(nodeId) || []));
    }
    const values = new Set();
    let failed = false;
    for (const nodeId of component) {
      const { map, failures, key } = nodes.get(nodeId);
      mergePrivateValues(values, map.get(key) || []);
      failed ||= failures.has(key);
    }
    for (const nodeId of component) {
      const { map, failures, key } = nodes.get(nodeId);
      if (!map.has(key)) map.set(key, new Set());
      mergePrivateValues(map.get(key), values);
      if (failed) failures.add(key);
    }
  }
}

function ownedPrivateValues(scope, map, key) {
  const values = new Set(scope.globallyDistinctive);
  mergePrivateValues(values, map.get(key) || []);
  return values;
}

function failClosedAcpText(value) {
  return value == null ? value : "[redacted]";
}

function scrubCopiedAcpContent(db, privateScope, { runIds, taskIds }) {
  const globallyDistinctive = privateScope.globallyDistinctive;
  if (hasColumn(db, "task_comments", "body")) {
    const update = db.prepare("UPDATE task_comments SET body = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, task_id, body FROM task_comments").all()) {
      const values = taskIds.has(row.task_id)
        ? ownedPrivateValues(privateScope, privateScope.byTask, row.task_id)
        : globallyDistinctive;
      const body = privateScope.failedTasks.has(row.task_id)
        ? failClosedAcpText(row.body)
        : redactPrivateAcpText(row.body, values);
      if (body !== row.body) update.run(body, row.id);
    }
  }
  if (taskIds.size && hasColumn(db, "tasks", "plan_body")) {
    const jsonColumns = [...TASK_JSON_DEFAULTS.keys()].filter((column) => hasColumn(db, "tasks", column));
    const textColumns = TASK_TEXT_COLUMNS.filter((column) => hasColumn(db, "tasks", column));
    const columns = [...jsonColumns, ...textColumns];
    const update = db.prepare(`
      UPDATE tasks SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?
    `);
    for (const row of db.prepare(`SELECT id, ${columns.join(", ")} FROM tasks`).all()) {
      if (!taskIds.has(row.id)) continue;
      const values = ownedPrivateValues(privateScope, privateScope.byTask, row.id);
      const forceFailure = privateScope.failedTasks.has(row.id);
      update.run(
        ...jsonColumns.map((column) => scrubAcpJson(row[column], values, { forceFailure })),
        ...textColumns.map((column) => forceFailure
          ? failClosedAcpText(row[column])
          : redactPrivateAcpText(row[column], values)),
        row.id,
      );
    }
  }

  if (runIds.size && hasColumn(db, "run_compactions", "metadata_json")) {
    const update = db.prepare(`
      UPDATE run_compactions SET summary = ?, metadata_json = ?, error_text = ? WHERE id = ?
    `);
    for (const row of db.prepare(`
      SELECT id, task_run_id, summary, metadata_json, error_text FROM run_compactions
      `).all()) {
      if (!runIds.has(row.task_run_id)) continue;
      const values = ownedPrivateValues(privateScope, privateScope.byRun, row.task_run_id);
      const forceFailure = privateScope.failedRuns.has(row.task_run_id);
      update.run(
        forceFailure ? failClosedAcpText(row.summary) : redactPrivateAcpText(row.summary, values),
        scrubAcpJson(row.metadata_json, values, { forceFailure }),
        forceFailure ? failClosedAcpText(row.error_text) : redactPrivateAcpText(row.error_text, values),
        row.id,
      );
    }
  }

  if (runIds.size && hasColumn(db, "task_run_approvals", "arguments_summary")) {
    const update = db.prepare(`
      UPDATE task_run_approvals SET arguments_summary = ?, model = ?, reason = ? WHERE id = ?
    `);
    for (const row of db.prepare(`
      SELECT id, task_run_id, arguments_summary, model, reason FROM task_run_approvals
      `).all()) {
      if (!runIds.has(row.task_run_id)) continue;
      const values = ownedPrivateValues(privateScope, privateScope.byRun, row.task_run_id);
      const forceFailure = privateScope.failedRuns.has(row.task_run_id);
      update.run(
        forceFailure
          ? failClosedAcpText(row.arguments_summary)
          : redactPrivateAcpText(row.arguments_summary, values),
        forceFailure ? failClosedAcpText(row.model) : redactPrivateAcpText(row.model, values),
        forceFailure ? failClosedAcpText(row.reason) : redactPrivateAcpText(row.reason, values),
        row.id,
      );
    }
  }

  if (runIds.size && hasColumn(db, "slack_delivery_log", "response_json")) {
    const update = db.prepare(`
      UPDATE slack_delivery_log SET text = ?, error_text = ?, response_json = ? WHERE id = ?
    `);
    for (const row of db.prepare(`
      SELECT id, task_run_id, text, error_text, response_json FROM slack_delivery_log
      `).all()) {
      if (!runIds.has(row.task_run_id)) continue;
      const values = ownedPrivateValues(privateScope, privateScope.byRun, row.task_run_id);
      const forceFailure = privateScope.failedRuns.has(row.task_run_id);
      update.run(
        forceFailure ? failClosedAcpText(row.text) : redactPrivateAcpText(row.text, values),
        forceFailure ? failClosedAcpText(row.error_text) : redactPrivateAcpText(row.error_text, values),
        scrubAcpJson(row.response_json, values, { forceFailure }),
        row.id,
      );
    }
  }

  const memoryIds = new Set();
  if (hasColumn(db, "agent_memories", "run_id")) {
    for (const row of db.prepare("SELECT id, run_id, task_id FROM agent_memories").all()) {
      if (runIds.has(row.run_id) || taskIds.has(row.task_id)) memoryIds.add(row.id);
    }
  }
  if (hasColumn(db, "embeddings", "chunk_text")) {
    const removeFts = hasColumn(db, "embeddings_fts", "id")
      ? db.prepare("DELETE FROM embeddings_fts WHERE id = ?")
      : null;
    const remove = db.prepare("DELETE FROM embeddings WHERE id = ?");
    for (const row of db.prepare("SELECT id, ref, source_ref, title, chunk_text, indexing_error FROM embeddings").all()) {
      const copied = [row.ref, row.source_ref, row.title, row.chunk_text, row.indexing_error]
        .some((value) => redactPrivateAcpText(value, globallyDistinctive) !== value);
      const linked = referenceContainsEntity(row.ref, taskIds)
        || referenceContainsEntity(row.source_ref, taskIds)
        || referenceContainsEntity(row.ref, memoryIds)
        || referenceContainsEntity(row.source_ref, memoryIds);
      if (!copied && !linked) continue;
      removeFts?.run(row.id);
      remove.run(row.id);
    }
  }
  if (memoryIds.size) {
    const remove = db.prepare("DELETE FROM agent_memories WHERE id = ?");
    for (const id of memoryIds) remove.run(id);
  }
}

function scrubLegacyAcpSessionData(db) {
  const privateScope = {
    all: new Set(),
    byProfile: new Map(),
    byRun: new Map(),
    byTask: new Map(),
    ownershipLinks: [],
    failedProfiles: new Set(),
    failedRuns: new Set(),
    failedTasks: new Set(),
    failedCells: new Set(),
  };
  const operationJsonColumns = ["request_json", "result_json", "error_json"]
    .filter((column) => hasColumn(db, "acp_operations", column));
  const operations = hasColumn(db, "acp_operations", "remote_session_id")
    ? db.prepare(`
        SELECT id, profile_id, kind, remote_session_id, ${operationJsonColumns.join(", ")}
        FROM acp_operations
      `).all()
    : [];
  for (const row of operations) {
    const values = new Set();
    addPrivateAcpIdentifier(values, row.remote_session_id);
    for (const column of operationJsonColumns) {
      const complete = collectJsonAcpIdentifiers(row[column], values, {
        includeCursors: row.kind === "list_sessions",
      });
      if (!complete) {
        privateScope.failedCells.add(`acp_operations:${row.id}:${column}`);
        markOwnedPrivateValueFailure(privateScope, { profileId: row.profile_id });
      }
    }
    addOwnedPrivateValues(privateScope, values, { profileId: row.profile_id });
  }

  const profileJsonColumns = ["last_probe_result_json", "last_probe_error_json"]
    .filter((column) => hasColumn(db, "acp_profiles", column));
  const profiles = profileJsonColumns.length
    ? db.prepare(`SELECT id, ${profileJsonColumns.join(", ")} FROM acp_profiles`).all()
    : [];
  for (const row of profiles) {
    const values = new Set();
    for (const column of profileJsonColumns) {
      const complete = collectJsonAcpIdentifiers(row[column], values);
      if (!complete) {
        privateScope.failedCells.add(`acp_profiles:${row.id}:${column}`);
        markOwnedPrivateValueFailure(privateScope, { profileId: row.id });
      }
    }
    addOwnedPrivateValues(privateScope, values, { profileId: row.id });
  }

  const interactions = hasColumn(db, "acp_interactions", "request_schema_json")
    ? db.prepare(`
        SELECT id, profile_id, protocol_request_id, kind, request_schema_json, disposition
        FROM acp_interactions
      `).all()
    : [];
  for (const row of interactions) {
    const values = new Set();
    const complete = collectJsonAcpIdentifiers(row.request_schema_json, values);
    if (!complete) {
      privateScope.failedCells.add(`acp_interactions:${row.id}:request_schema_json`);
      markOwnedPrivateValueFailure(privateScope, { profileId: row.profile_id });
    }
    addOwnedPrivateValues(privateScope, values, { profileId: row.profile_id });
  }

  const runJsonColumns = [
    "diagnostics_json",
    "result_json",
    "warnings_json",
    "transcript_tail_json",
    "artifact_paths_json",
    "artifacts_json",
    "artifact_summary_json",
    "todo_state_json",
    "capabilities_used_json",
    "failover_history_json",
    "tool_usage_summary_json",
  ].filter((column) => hasColumn(db, "task_runs", column));
  const runTextColumns = ["error_text", "summary", "details"]
    .filter((column) => hasColumn(db, "task_runs", column));
  const runs = hasColumn(db, "task_runs", "provider_session_id")
    ? db.prepare(`
        SELECT r.id, r.task_id, r.agent_name, r.provider_session_id,
               ${[...runJsonColumns, ...runTextColumns].map((column) => `r.${column}`).join(", ")},
               p.id AS profile_id
        FROM task_runs r
        LEFT JOIN acp_profiles p ON p.agent_name = r.agent_name
        WHERE r.provider_kind = 'acp'
      `).all()
    : [];
  for (const row of runs) {
    const values = new Set();
    addPrivateAcpIdentifier(values, row.provider_session_id);
    for (const column of runJsonColumns) {
      const complete = collectJsonAcpIdentifiers(row[column], values, { includeCursors: true });
      if (!complete) {
        privateScope.failedCells.add(`task_runs:${row.id}:${column}`);
        markOwnedPrivateValueFailure(privateScope, {
          profileId: row.profile_id,
          runId: row.id,
          taskId: row.task_id,
        });
      }
    }
    addOwnedPrivateValues(privateScope, values, {
      profileId: row.profile_id,
      runId: row.id,
      taskId: row.task_id,
    });
  }

  const logs = hasColumn(db, "agent_logs", "events") && hasColumn(db, "task_runs", "provider_kind")
    ? db.prepare(`
        SELECT l.id, l.task_run_id, r.task_id, p.id AS profile_id, l.events
        FROM agent_logs l
        JOIN task_runs r ON r.id = l.task_run_id
        LEFT JOIN acp_profiles p ON p.agent_name = r.agent_name
        WHERE r.provider_kind = 'acp'
      `).all()
    : [];
  for (const row of logs) {
    const values = new Set();
    const complete = collectJsonAcpIdentifiers(row.events, values, { includeCursors: true });
    if (!complete) {
      privateScope.failedCells.add(`agent_logs:${row.id}:events`);
      markOwnedPrivateValueFailure(privateScope, {
        profileId: row.profile_id,
        runId: row.task_run_id,
        taskId: row.task_id,
      });
    }
    addOwnedPrivateValues(privateScope, values, {
      profileId: row.profile_id,
      runId: row.task_run_id,
      taskId: row.task_id,
    });
  }
  propagatePrivateValueOwnership(privateScope);
  privateScope.globallyDistinctive = new Set(
    [...privateScope.all].filter(globallyDistinctivePrivateValue),
  );

  const transaction = db.transaction(() => {
    const updateOperation = db.prepare(`
      UPDATE acp_operations
      SET remote_session_id = ?, ${operationJsonColumns.map((column) => `${column} = ?`).join(", ")}
      WHERE id = ?
    `);
    for (const row of operations) {
      const values = ownedPrivateValues(privateScope, privateScope.byProfile, row.profile_id);
      const forceFailure = privateScope.failedProfiles.has(row.profile_id);
      updateOperation.run(
        null,
        ...operationJsonColumns.map((column) => scrubAcpOperationJson(row, column, values, {
          forceFailure: forceFailure
            || privateScope.failedCells.has(`acp_operations:${row.id}:${column}`),
        })),
        row.id,
      );
    }
    for (const row of profiles) {
      updateJsonColumns(
        db,
        "acp_profiles",
        row.id,
        profileJsonColumns,
        row,
        ownedPrivateValues(privateScope, privateScope.byProfile, row.id),
        privateScope.failedCells,
        { forceFailure: privateScope.failedProfiles.has(row.id) },
      );
    }

    const updateInteraction = db.prepare(`
      UPDATE acp_interactions
      SET protocol_request_id = ?, request_schema_json = ?, disposition = ?
      WHERE id = ?
    `);
    for (const row of interactions) {
      if (row.kind === "url") {
        updateInteraction.run(
          backupUrlProtocolRequestId(row.id),
          ACP_URL_PUBLIC_REQUEST_JSON,
          ACP_INTERACTION_DISPOSITIONS.has(row.disposition) ? row.disposition : null,
          row.id,
        );
        continue;
      }
      const values = ownedPrivateValues(privateScope, privateScope.byProfile, row.profile_id);
      const forceFailure = privateScope.failedProfiles.has(row.profile_id);
      const redactedProtocolId = forceFailure
        ? "[redacted]"
        : redactPrivateAcpText(row.protocol_request_id, values);
      updateInteraction.run(
        redactedProtocolId === row.protocol_request_id ? row.protocol_request_id : `backup:${row.id}`,
        scrubAcpJson(row.request_schema_json, values, {
          forceFailure: forceFailure
            || privateScope.failedCells.has(`acp_interactions:${row.id}:request_schema_json`),
        }),
        row.disposition,
        row.id,
      );
    }

    const updateRun = db.prepare(`
      UPDATE task_runs
      SET provider_session_id = ?,
          ${[...runJsonColumns, ...runTextColumns].map((column) => `${column} = ?`).join(", ")}
      WHERE id = ?
    `);
    for (const row of runs) {
      const values = ownedPrivateValues(privateScope, privateScope.byRun, row.id);
      const forceFailure = privateScope.failedRuns.has(row.id);
      updateRun.run(
        null,
        ...runJsonColumns.map((column) => scrubAcpJson(row[column], values, {
          includeCursors: true,
          forceFailure: forceFailure
            || privateScope.failedCells.has(`task_runs:${row.id}:${column}`),
        })),
        ...runTextColumns.map((column) => forceFailure
          ? failClosedAcpText(row[column])
          : redactPrivateAcpText(row[column], values)),
        row.id,
      );
    }

    const updateLog = db.prepare("UPDATE agent_logs SET events = ? WHERE id = ?");
    for (const row of logs) {
      const forceFailure = privateScope.failedRuns.has(row.task_run_id);
      updateLog.run(scrubAcpJson(
        row.events,
        ownedPrivateValues(privateScope, privateScope.byRun, row.task_run_id),
        {
          includeCursors: true,
          forceFailure: forceFailure
            || privateScope.failedCells.has(`agent_logs:${row.id}:events`),
        },
      ), row.id);
    }
    scrubCopiedAcpContent(db, privateScope, {
      runIds: new Set(runs.map((row) => row.id)),
      taskIds: new Set(runs.map((row) => row.task_id).filter(Boolean)),
    });
  });
  transaction();
}

function scrubWebhookCredentials(db) {
  if (!hasColumn(db, "automations", "webhook_id") || !hasColumn(db, "automations", "trigger_json")) return;
  const rows = db.prepare("SELECT id, webhook_id, trigger_json FROM automations").all();
  const update = db.prepare(`
    UPDATE automations
    SET trigger_json = ?, webhook_id = NULL, enabled = 0, next_fire_at = NULL, last_error = ?
    WHERE id = ?
  `);
  const scrub = db.transaction(() => {
    for (const row of rows) {
      let trigger = null;
      try { trigger = JSON.parse(row.trigger_json || "{}"); } catch { /* malformed data is not a webhook by type */ }
      if (!row.webhook_id && trigger?.type !== "webhook") continue;
      update.run(
        JSON.stringify({ type: "webhook", reconfiguration_required: true }),
        WEBHOOK_RECONFIGURATION_MESSAGE,
        row.id,
      );
    }
  });
  scrub();
}

async function createSanitizedDatabase(sourcePath, targetPath) {
  const source = openDb(sourcePath);
  try {
    source.pragma("wal_checkpoint(TRUNCATE)");
    await source.backup(targetPath);
  } finally {
    source.close();
  }

  const copy = openDb(targetPath);
  try {
    if (hasColumn(copy, "custom_providers", "api_key_encrypted")) {
      copy.prepare("UPDATE custom_providers SET api_key_encrypted = NULL").run();
    }
    if (hasColumn(copy, "push_subscriptions", "keys_json")) {
      copy.prepare("DELETE FROM push_subscriptions").run();
    }
    scrubWebhookCredentials(copy);
    scrubLegacyAcpSessionData(copy);
    // Rebuild the file so removed credentials cannot survive in free pages.
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
  chmodSync(targetPath, PRIVATE_ARCHIVE_MODE);
}

function stageNonSecretConfig(dataDir, stagingDir) {
  const source = join(dataDir, "config");
  if (!existsSync(source)) return;
  cpSync(source, join(stagingDir, "config"), {
    recursive: true,
    filter(path) {
      if (path === source) return true;
      const name = basename(path);
      return name !== "mcp.json" && !SECRET_ROOT_FILES.has(name);
    },
  });
}

function canonicalPath(path) {
  const pending = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    pending.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...pending);
}

function isSameOrDescendant(parent, candidate) {
  const nested = relative(canonicalPath(parent), canonicalPath(candidate));
  return !nested || (!isAbsolute(nested) && nested !== ".." && !nested.startsWith(`..${sep}`));
}

function backupEntries(dataDir) {
  return readdirSync(dataDir)
    .filter((name) => !OMITTED_ROOT_ENTRIES.has(name))
    .map((name) => `./${name}`);
}

export async function backup(args = []) {
  applyConfigArgs(args);
  const outIndex = args.indexOf("--out");
  const outDir = outIndex >= 0 ? args[outIndex + 1] : join(homedir(), "worklab-backups");
  if (!outDir) throw new Error("--out requires a directory");
  const config = loadConfig();
  if (!existsSync(config.dataDir)) throw new Error(`data dir does not exist: ${config.dataDir}`);
  if (isSameOrDescendant(config.dataDir, outDir)) {
    throw new Error(`backup output directory must be outside the Worklab data directory: ${config.dataDir}`);
  }
  mkdirSync(outDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(outDir, PRIVATE_DIRECTORY_MODE);

  const archive = join(outDir, `${timestamp()}.tar.gz`);
  const stagingDir = mkdtempSync(join(tmpdir(), "worklab-backup-"));
  chmodSync(stagingDir, PRIVATE_DIRECTORY_MODE);
  let completed = false;
  try {
    const dbPath = join(config.dataDir, "worklab.db");
    if (existsSync(dbPath)) {
      await createSanitizedDatabase(dbPath, join(stagingDir, "worklab.db"));
    }
    stageNonSecretConfig(config.dataDir, stagingDir);

    // Pre-create the destination privately. tar truncates the file without
    // widening its mode, and the final chmod defends against tar variants that
    // replace it instead.
    closeSync(openSync(archive, "w", PRIVATE_ARCHIVE_MODE));
    chmodSync(archive, PRIVATE_ARCHIVE_MODE);
    execFileSync("tar", [
      "--exclude=*.db-wal",
      "--exclude=*.db-shm",
      "-czf",
      archive,
      "-C",
      config.dataDir,
      ...backupEntries(config.dataDir),
      "-C",
      stagingDir,
      ".",
    ], { stdio: "pipe" });
    chmodSync(archive, PRIVATE_ARCHIVE_MODE);
    completed = true;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
    if (!completed) rmSync(archive, { force: true });
  }
  console.log(`backup: ${archive}`);
  console.log(`restore: mkdir -p ${config.dataDir} && tar -xzf ${archive} -C ${config.dataDir}`);
}
