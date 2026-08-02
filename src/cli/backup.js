import { execFileSync } from "node:child_process";
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
import { loadConfig, normalizeAcpProviderSessionId, openDb } from "../core/index.js";
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
  "config",
  "logs",
  "worklab.db",
]);

const WEBHOOK_RECONFIGURATION_MESSAGE = "Webhook credential omitted from backup; edit the automation to generate a new webhook ID.";
const RAW_ACP_SESSION_KEYS = new Set(["sessionId", "session_id", "remoteSessionId", "remote_session_id"]);
const PROVIDER_ACP_SESSION_KEYS = new Set(["providerSessionId", "provider_session_id"]);
const ACP_OPERATION_CURSOR_KEYS = Object.freeze({
  request_json: ["cursor"],
  result_json: ["nextCursor", "next_cursor"],
});
const ACP_SESSION_CURSOR_RE = /^acp-cursor:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z0-9_-]+)$/u;
const MAX_ACP_SESSION_CURSOR_CHARS = 5600;
const MAX_ACP_SCRUB_DEPTH = 32;
const MAX_ACP_SCRUB_NODES = 10_000;
const MAX_ACP_JSON_CHARS = 16 * 1024 * 1024;
const ACP_SCRUB_FALLBACK = { redacted: true, reason: "ACP session data exceeded backup scrub limits" };
const ACP_CURSOR_SCRUB_FALLBACK = { redacted: true, reason: "ACP pagination cursor data was invalid" };

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

function isEncodedAcpSessionId(value) {
  try {
    normalizeAcpProviderSessionId(value);
    return true;
  } catch {
    return false;
  }
}

function decodedAcpSessionId(value) {
  if (!isEncodedAcpSessionId(value)) return null;
  const encoded = value.slice(value.lastIndexOf(":") + 1);
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return decoded && Buffer.from(decoded, "utf8").toString("base64url") === encoded ? decoded : null;
  } catch {
    return null;
  }
}

function addPrivateAcpIdentifier(values, value) {
  if (typeof value !== "string" || !value) return;
  if (isEncodedAcpSessionId(value)) {
    const decoded = decodedAcpSessionId(value);
    if (decoded) values.add(decoded);
    return;
  }
  values.add(value);
}

function canonicalAcpSessionCursor(value, profileId) {
  return decodedAcpSessionCursor(value, profileId)?.canonical ?? null;
}

function decodedAcpSessionCursor(value, profileId) {
  if (typeof value !== "string"
    || typeof profileId !== "string"
    || !profileId
    || value.length > MAX_ACP_SESSION_CURSOR_CHARS) return null;
  const match = ACP_SESSION_CURSOR_RE.exec(value);
  if (!match || match[1] !== profileId) return null;
  try {
    const bytes = Buffer.from(match[2], "base64url");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes.length > 0
      && bytes.length <= 4096
      && bytes.toString("base64url") === match[2]
      && decoded
      && decoded.trim() === decoded
      && !decoded.includes("\0")
      ? { canonical: value, decoded }
      : null;
  } catch {
    return null;
  }
}

function legacyAcpSessionCursor(value) {
  return typeof value === "string"
    && !value.startsWith("acp-cursor:")
    && value.length > 0
    && value.length <= MAX_ACP_SESSION_CURSOR_CHARS
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
  sessionRecord = false,
  parentKey = "",
  depth = 0,
  state = scrubTraversalState(),
} = {}) {
  if (!enterScrubNode(value, state, depth)) return state;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectAcpIdentifiers(entry, values, {
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
    if (RAW_ACP_SESSION_KEYS.has(key) || PROVIDER_ACP_SESSION_KEYS.has(key) || (sessionRecord && key === "id")) {
      addPrivateAcpIdentifier(values, entry);
    }
    collectAcpIdentifiers(entry, values, { parentKey: key, depth: depth + 1, state });
    if (state.failed) break;
  }
  return state;
}

function collectJsonAcpIdentifiers(text, values) {
  if (text == null) return true;
  const serialized = String(text || "");
  const pattern = /"(?:sessionId|session_id|remoteSessionId|remote_session_id|providerSessionId|provider_session_id)"\s*:\s*"((?:\\.|[^"\\])*)"/gu;
  let matches = 0;
  for (const match of serialized.matchAll(pattern)) {
    try { addPrivateAcpIdentifier(values, JSON.parse(`"${match[1]}"`)); } catch { /* ignore malformed strings */ }
    matches += 1;
    if (matches >= MAX_ACP_SCRUB_NODES) break;
  }
  if (serialized.length > MAX_ACP_JSON_CHARS) return false;
  const parsed = parseJson(text);
  if (parsed.ok) {
    return !collectAcpIdentifiers(parsed.value, values).failed;
  }
  return false;
}

function redactPrivateAcpText(value, privateValues) {
  if (typeof value !== "string" || !value) return value;
  let output = value;
  for (const identifier of [...privateValues].sort((a, b) => b.length - a.length)) {
    output = output.split(identifier).join("[redacted]");
  }
  return output;
}

function scrubAcpValue(value, privateValues, {
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
        sessionRecord: parentKey === "sessions",
        depth: depth + 1,
        state,
      }));
      if (state.failed) break;
    }
    return output;
  }
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (RAW_ACP_SESSION_KEYS.has(key)) continue;
    if (PROVIDER_ACP_SESSION_KEYS.has(key) && !isEncodedAcpSessionId(entry)) continue;
    if (sessionRecord && key === "id" && !isEncodedAcpSessionId(entry)) continue;
    output[key] = scrubAcpValue(entry, privateValues, {
      parentKey: key,
      depth: depth + 1,
      state,
    });
    if (state.failed) break;
  }
  return output;
}

function scrubAcpJson(text, privateValues) {
  if (text == null) return text;
  if (String(text || "").length > MAX_ACP_JSON_CHARS) return JSON.stringify(ACP_SCRUB_FALLBACK);
  const parsed = parseJson(text);
  if (!parsed.ok) return redactPrivateAcpText(text, privateValues);
  const state = scrubTraversalState();
  const scrubbed = scrubAcpValue(parsed.value, privateValues, { state });
  return JSON.stringify(state.failed ? ACP_SCRUB_FALLBACK : scrubbed);
}

function operationCursorFields(row, column) {
  return row.kind === "list_sessions" ? ACP_OPERATION_CURSOR_KEYS[column] || [] : [];
}

function collectOperationCursorIdentifiers(row, column, privateValues) {
  const fields = operationCursorFields(row, column);
  if (!fields.length || row[column] == null || String(row[column]).length > MAX_ACP_JSON_CHARS) return;
  const parsed = parseJson(row[column]);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return;
  for (const field of fields) {
    if (!Object.hasOwn(parsed.value, field)) continue;
    const candidate = parsed.value[field];
    const decoded = decodedAcpSessionCursor(candidate, row.profile_id)?.decoded;
    if (decoded) privateValues.add(decoded);
    else if (typeof candidate === "string" && candidate) privateValues.add(candidate);
  }
}

function scrubAcpOperationJson(row, column, privateValues) {
  const fields = operationCursorFields(row, column);
  if (!fields.length) return scrubAcpJson(row[column], privateValues);
  if (row[column] == null) return row[column];
  if (String(row[column]).length > MAX_ACP_JSON_CHARS) return JSON.stringify(ACP_SCRUB_FALLBACK);
  const parsed = parseJson(row[column]);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return JSON.stringify(ACP_CURSOR_SCRUB_FALLBACK);
  }

  const cursors = new Map();
  for (const field of fields) {
    if (!Object.hasOwn(parsed.value, field)) continue;
    const candidate = parsed.value[field];
    if (candidate == null) {
      cursors.set(field, null);
      continue;
    }
    const canonical = canonicalAcpSessionCursor(candidate, row.profile_id);
    if (canonical) {
      cursors.set(field, canonical);
      continue;
    }
    const legacy = legacyAcpSessionCursor(candidate);
    if (legacy) {
      cursors.set(field, null);
      continue;
    }
    return JSON.stringify(ACP_CURSOR_SCRUB_FALLBACK);
  }

  const state = scrubTraversalState();
  const scrubbed = scrubAcpValue(parsed.value, privateValues, { state });
  if (state.failed) return JSON.stringify(ACP_SCRUB_FALLBACK);
  for (const [field, cursor] of cursors) {
    if (cursor) scrubbed[field] = cursor;
    else delete scrubbed[field];
  }
  return JSON.stringify(scrubbed);
}

function updateJsonColumns(db, table, id, columns, row, privateValues) {
  if (!columns.length) return;
  db.prepare(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
    .run(...columns.map((column) => scrubAcpJson(row[column], privateValues)), id);
}

function scrubCopiedAcpContent(db, privateValues) {
  if (!privateValues.size) return;
  if (hasColumn(db, "task_comments", "body")) {
    const update = db.prepare("UPDATE task_comments SET body = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, body FROM task_comments").all()) {
      const body = redactPrivateAcpText(row.body, privateValues);
      if (body !== row.body) update.run(body, row.id);
    }
  }
  if (hasColumn(db, "embeddings", "chunk_text")) {
    const removeFts = hasColumn(db, "embeddings_fts", "id")
      ? db.prepare("DELETE FROM embeddings_fts WHERE id = ?")
      : null;
    const remove = db.prepare("DELETE FROM embeddings WHERE id = ?");
    for (const row of db.prepare("SELECT id, ref, source_ref, title, chunk_text, indexing_error FROM embeddings").all()) {
      const copied = [row.ref, row.source_ref, row.title, row.chunk_text, row.indexing_error]
        .some((value) => redactPrivateAcpText(value, privateValues) !== value);
      if (!copied) continue;
      removeFts?.run(row.id);
      remove.run(row.id);
    }
  }
}

function scrubLegacyAcpSessionData(db) {
  const privateValues = new Set();
  const operationJsonColumns = ["request_json", "result_json", "error_json"]
    .filter((column) => hasColumn(db, "acp_operations", column));
  const operations = hasColumn(db, "acp_operations", "remote_session_id")
    ? db.prepare(`
        SELECT id, profile_id, kind, remote_session_id, ${operationJsonColumns.join(", ")}
        FROM acp_operations
      `).all()
    : [];
  for (const row of operations) {
    addPrivateAcpIdentifier(privateValues, row.remote_session_id);
    for (const column of operationJsonColumns) {
      collectJsonAcpIdentifiers(row[column], privateValues);
      collectOperationCursorIdentifiers(row, column, privateValues);
    }
  }

  const profileJsonColumns = ["last_probe_result_json", "last_probe_error_json"]
    .filter((column) => hasColumn(db, "acp_profiles", column));
  const profiles = profileJsonColumns.length
    ? db.prepare(`SELECT id, ${profileJsonColumns.join(", ")} FROM acp_profiles`).all()
    : [];
  for (const row of profiles) {
    for (const column of profileJsonColumns) collectJsonAcpIdentifiers(row[column], privateValues);
  }

  const interactions = hasColumn(db, "acp_interactions", "request_schema_json")
    ? db.prepare("SELECT id, protocol_request_id, request_schema_json FROM acp_interactions").all()
    : [];
  for (const row of interactions) {
    collectJsonAcpIdentifiers(row.request_schema_json, privateValues);
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
        SELECT id, provider_session_id, ${[...runJsonColumns, ...runTextColumns].join(", ")}
        FROM task_runs WHERE provider_kind = 'acp'
      `).all()
    : [];
  for (const row of runs) {
    addPrivateAcpIdentifier(privateValues, row.provider_session_id);
    for (const column of runJsonColumns) collectJsonAcpIdentifiers(row[column], privateValues);
  }

  const logs = hasColumn(db, "agent_logs", "events") && hasColumn(db, "task_runs", "provider_kind")
    ? db.prepare(`
        SELECT l.id, l.events FROM agent_logs l
        JOIN task_runs r ON r.id = l.task_run_id
        WHERE r.provider_kind = 'acp'
      `).all()
    : [];
  for (const row of logs) collectJsonAcpIdentifiers(row.events, privateValues);

  const transaction = db.transaction(() => {
    const updateOperation = db.prepare(`
      UPDATE acp_operations
      SET remote_session_id = ?, ${operationJsonColumns.map((column) => `${column} = ?`).join(", ")}
      WHERE id = ?
    `);
    for (const row of operations) {
      const remoteSessionId = isEncodedAcpSessionId(row.remote_session_id) ? row.remote_session_id : null;
      updateOperation.run(
        remoteSessionId,
        ...operationJsonColumns.map((column) => scrubAcpOperationJson(row, column, privateValues)),
        row.id,
      );
    }
    for (const row of profiles) updateJsonColumns(db, "acp_profiles", row.id, profileJsonColumns, row, privateValues);

    const updateInteraction = db.prepare(`
      UPDATE acp_interactions SET protocol_request_id = ?, request_schema_json = ? WHERE id = ?
    `);
    for (const row of interactions) {
      const redactedProtocolId = redactPrivateAcpText(row.protocol_request_id, privateValues);
      updateInteraction.run(
        redactedProtocolId === row.protocol_request_id ? row.protocol_request_id : `backup:${row.id}`,
        scrubAcpJson(row.request_schema_json, privateValues),
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
      updateRun.run(
        isEncodedAcpSessionId(row.provider_session_id) ? row.provider_session_id : null,
        ...runJsonColumns.map((column) => scrubAcpJson(row[column], privateValues)),
        ...runTextColumns.map((column) => redactPrivateAcpText(row[column], privateValues)),
        row.id,
      );
    }

    const updateLog = db.prepare("UPDATE agent_logs SET events = ? WHERE id = ?");
    for (const row of logs) updateLog.run(scrubAcpJson(row.events, privateValues), row.id);
    scrubCopiedAcpContent(db, privateValues);
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
