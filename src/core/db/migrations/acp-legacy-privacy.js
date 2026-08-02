import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  createAcpEventPrivacyBoundary,
  validateAcpProviderSessionId,
} from "../../acp-privacy.js";
import { runLogPathInsideDataDir } from "../../run-event-store.js";

const ACP_PRIVACY_COMPACTION_KEY = "acp_legacy_session_privacy_compacted_v1";
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_RAW_LOG_BYTES = 16 * 1024 * 1024;
const LEGACY_PRIVACY_EVENT = Object.freeze({
  type: "privacy_redaction",
  reason: "legacy_acp_session_data",
});

const RUN_JSON_DEFAULTS = new Map([
  ["artifact_paths_json", []],
  ["artifacts_json", []],
  ["artifact_summary_json", {}],
  ["todo_state_json", { todos: [], updated_at: null, update_count: 0 }],
  ["warnings_json", []],
  ["diagnostics_json", null],
  ["result_json", null],
  ["transcript_tail_json", null],
  ["capabilities_used_json", null],
  ["failover_history_json", null],
  ["tool_usage_summary_json", null],
]);
const RUN_TEXT_COLUMNS = ["error_text", "summary", "details"];
const EXPLICIT_SESSION_VALUE_RE = /"(sessionId|session_id|providerSessionId|provider_session_id|cursor|nextCursor|next_cursor)"\s*:\s*"((?:\\.|[^"\\])*)"/gu;
const TASK_EMBEDDING_KINDS = new Set([
  "task",
  "tasks",
  "comment",
  "comments",
  "task_comment",
  "task_comments",
  "task-comment",
  "task-comments",
]);
const TASK_REFERENCE_SEGMENTS = new Set(["task", "tasks"]);
const COMMENT_REFERENCE_SEGMENTS = new Set([
  "comment",
  "comments",
  "task_comment",
  "task_comments",
  "task-comment",
  "task-comments",
]);

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function tableExists(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?").get(table);
}

function parseJson(value, fallback) {
  if (value == null) return { value: fallback, valid: true };
  try {
    return { value: JSON.parse(value), valid: true };
  } catch {
    return { value: fallback, valid: false };
  }
}

function explicitSessionSeeds(text) {
  const seeds = [];
  for (const match of String(text || "").matchAll(EXPLICIT_SESSION_VALUE_RE)) {
    try {
      seeds.push({ [match[1]]: JSON.parse(`"${match[2]}"`) });
    } catch {
      // The containing JSON is already replaced fail-closed; an invalid JSON
      // string cannot be decoded into a reliable identifier for redaction.
    }
  }
  return seeds;
}

function profileIdFromHandle(value) {
  if (typeof value !== "string") return null;
  const match = /^acp:v1:([^:]+):/u.exec(value);
  if (!match || !PROFILE_ID_RE.test(match[1])) return null;
  return validateAcpProviderSessionId(value, match[1]) ? match[1] : null;
}

function profileIdForRun(row) {
  for (const candidate of [
    row.acp_profile_id,
    typeof row.agent_model === "string" && row.agent_model.startsWith("acp:")
      ? row.agent_model.slice(4)
      : null,
    profileIdFromHandle(row.provider_session_id),
  ]) {
    if (typeof candidate === "string" && PROFILE_ID_RE.test(candidate)) return candidate;
  }
  // Keeps the boundary active and fail-closed for orphaned legacy ACP rows.
  return "legacy-acp-orphan";
}

function referenceSegments(value) {
  return String(value || "")
    .split(/[/:#]/u)
    .filter(Boolean)
    .map((segment) => segment.replace(/\.md$/iu, ""));
}

function referenceLinksEntity(value, ids, entitySegments, kind) {
  const segments = referenceSegments(value);
  for (let index = 0; index < segments.length; index += 1) {
    if (!ids.has(segments[index])) continue;
    if (TASK_EMBEDDING_KINDS.has(String(kind || "").toLowerCase())) return true;
    if (index > 0 && entitySegments.has(segments[index - 1].toLowerCase())) return true;
  }
  return false;
}

function linkedEmbeddingRows(db, taskId, comments) {
  if (!taskId || !tableExists(db, "embeddings")) return [];
  const taskIds = new Set([taskId]);
  const commentIds = new Set(comments.map((row) => row.id));
  return db.prepare("SELECT id, kind, ref, source_ref FROM embeddings ORDER BY rowid ASC").all()
    .filter((row) => (
      referenceLinksEntity(row.source_ref, taskIds, TASK_REFERENCE_SEGMENTS, row.kind)
      || referenceLinksEntity(row.ref, taskIds, TASK_REFERENCE_SEGMENTS, row.kind)
      || referenceLinksEntity(row.source_ref, commentIds, COMMENT_REFERENCE_SEGMENTS, row.kind)
      || referenceLinksEntity(row.ref, commentIds, COMMENT_REFERENCE_SEGMENTS, row.kind)
    ));
}

function databaseDataDir(db) {
  const main = db.pragma("database_list").find((entry) => entry.name === "main");
  return main?.file ? dirname(main.file) : null;
}

function rawLogForRun(rawOutputPath, dataDir) {
  if (!rawOutputPath || !dataDir) {
    return { path: null, events: [], seeds: [], detach: !!rawOutputPath, forceFailure: false };
  }
  const path = runLogPathInsideDataDir(rawOutputPath, dataDir);
  if (!path || !existsSync(path)) {
    return { path: null, events: [], seeds: [], detach: !path, forceFailure: false };
  }
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_RAW_LOG_BYTES) {
    return { path, events: [], seeds: [], detach: false, forceFailure: true };
  }
  const events = [];
  const seeds = [];
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    seeds.push(...explicitSessionSeeds(line));
    try {
      const parsed = JSON.parse(line);
      events.push(parsed && typeof parsed === "object" ? parsed : LEGACY_PRIVACY_EVENT);
    } catch {
      events.push(LEGACY_PRIVACY_EVENT);
    }
  }
  return { path, events, seeds, detach: false, forceFailure: false, mode: stat.mode & 0o777 };
}

function rewriteRawLog(rawLog, events) {
  if (!rawLog.path) return false;
  const content = `${events.map((event) => JSON.stringify(event)).join("\n")}${events.length ? "\n" : ""}`;
  const current = rawLog.forceFailure ? null : readFileSync(rawLog.path, "utf8");
  if (current === content) return false;
  const temporary = join(dirname(rawLog.path), `.worklab-acp-privacy-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: rawLog.mode || 0o600 });
    chmodSync(temporary, rawLog.mode || 0o600);
    renameSync(temporary, rawLog.path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
  return true;
}

function jsonColumnsForRun(db) {
  return [...RUN_JSON_DEFAULTS.keys()].filter((column) => hasColumn(db, "task_runs", column));
}

function acpRuns(db, jsonColumns, textColumns) {
  if (!tableExists(db, "task_runs") || !hasColumn(db, "task_runs", "provider_kind")) return [];
  const selected = [
    "r.id",
    "r.task_id",
    "r.agent_name",
    "r.provider_kind",
    "r.provider_session_id",
    "r.raw_output_path",
    ...jsonColumns.map((column) => `r.${column}`),
    ...textColumns.map((column) => `r.${column}`),
    "p.id AS acp_profile_id",
    "a.model AS agent_model",
  ];
  return db.prepare(`
    SELECT ${selected.join(", ")}
    FROM task_runs r
    LEFT JOIN acp_profiles p ON p.agent_name = r.agent_name
    LEFT JOIN agents a ON a.name = r.agent_name
    WHERE r.provider_kind = 'acp'
       OR ((r.provider_kind IS NULL OR r.provider_kind = '') AND (
         p.id IS NOT NULL OR a.sdk = 'acp' OR a.execution_mode = 'acp' OR a.model LIKE 'acp:%'
       ))
    ORDER BY r.started_at ASC, r.rowid ASC
  `).all();
}

function relatedRows(db, run) {
  const logs = tableExists(db, "agent_logs")
    ? db.prepare("SELECT id, events FROM agent_logs WHERE task_run_id = ? ORDER BY rowid ASC").all(run.id)
    : [];
  const comments = run.task_id && tableExists(db, "task_comments")
    ? db.prepare("SELECT id, body FROM task_comments WHERE task_id = ? ORDER BY rowid ASC").all(run.task_id)
    : [];
  const compactions = tableExists(db, "run_compactions")
    ? db.prepare("SELECT id, summary, metadata_json, error_text FROM run_compactions WHERE task_run_id = ? ORDER BY rowid ASC").all(run.id)
    : [];
  const interactions = tableExists(db, "acp_interactions")
    ? db.prepare("SELECT id, protocol_request_id, request_schema_json, disposition FROM acp_interactions WHERE task_run_id = ? ORDER BY rowid ASC").all(run.id)
    : [];
  const embeddings = linkedEmbeddingRows(db, run.task_id, comments);
  return { logs, comments, compactions, interactions, embeddings };
}

function preparedRunValue(run, jsonColumns, textColumns, related, rawLog) {
  const seeds = [...rawLog.seeds];
  const runJson = {};
  for (const column of jsonColumns) {
    seeds.push(...explicitSessionSeeds(run[column]));
    runJson[column] = parseJson(run[column], RUN_JSON_DEFAULTS.get(column)).value;
  }
  const logs = related.logs.map((row) => {
    seeds.push(...explicitSessionSeeds(row.events));
    return { events: parseJson(row.events, []).value };
  });
  const compactions = related.compactions.map((row) => {
    seeds.push(...explicitSessionSeeds(row.metadata_json));
    return {
      summary: row.summary,
      metadata_json: parseJson(row.metadata_json, {}).value,
      error_text: row.error_text,
    };
  });
  const interactions = related.interactions.map((row) => {
    seeds.push(...explicitSessionSeeds(row.request_schema_json));
    return {
      protocolRequestId: row.protocol_request_id,
      request_schema_json: parseJson(row.request_schema_json, {}).value,
      disposition: row.disposition,
    };
  });
  return {
    providerSessionId: run.provider_session_id,
    rawOutputPath: run.raw_output_path,
    runJson,
    runText: Object.fromEntries(textColumns.map((column) => [column, run[column]])),
    logs,
    comments: related.comments.map((row) => ({ body: row.body })),
    compactions,
    interactions,
    rawEvents: rawLog.events,
    legacySessionSeeds: seeds,
  };
}

function failedClosedValue(run, jsonColumns, textColumns, related, rawLog, profileId) {
  return {
    providerSessionId: validateAcpProviderSessionId(run.provider_session_id, profileId),
    rawOutputPath: rawLog.detach ? null : run.raw_output_path,
    runJson: Object.fromEntries(jsonColumns.map((column) => [column, RUN_JSON_DEFAULTS.get(column)])),
    runText: Object.fromEntries(textColumns.map((column) => [column, null])),
    logs: related.logs.map(() => ({ events: [] })),
    comments: related.comments.map(() => ({ body: "[redacted]" })),
    compactions: related.compactions.map((row) => ({
      summary: "[redacted]",
      metadata_json: {},
      error_text: row.error_text == null ? null : "[redacted]",
    })),
    interactions: related.interactions.map((row) => ({
      protocolRequestId: null,
      request_schema_json: {},
      disposition: row.disposition,
    })),
    rawEvents: [LEGACY_PRIVACY_EVENT],
  };
}

function serializedJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function applyRunPlan(db, run, plan, jsonColumns, textColumns, related) {
  let changes = 0;
  const providerSessionId = plan.providerSessionId || null;
  const rawOutputPath = plan.rawOutputPath === run.raw_output_path
    ? (plan.rawOutputPath || null)
    : null;
  const jsonValues = jsonColumns.map((column) => {
    const value = plan.runJson?.[column];
    return value == null && RUN_JSON_DEFAULTS.get(column) === null
      ? null
      : serializedJson(value, RUN_JSON_DEFAULTS.get(column));
  });
  const textValues = textColumns.map((column) => plan.runText?.[column] ?? null);
  const runValues = [
    providerSessionId,
    rawOutputPath,
    ...jsonValues,
    ...textValues,
    run.id,
  ];
  const runChanged = providerSessionId !== (run.provider_session_id || null)
    || rawOutputPath !== (run.raw_output_path || null)
    || jsonColumns.some((column, index) => jsonValues[index] !== run[column])
    || textColumns.some((column, index) => textValues[index] !== run[column]);
  if (runChanged) {
    changes += db.prepare(`
      UPDATE task_runs SET provider_session_id = ?, raw_output_path = ?,
        ${[
          ...jsonColumns.map((column) => `${column} = ?`),
          ...textColumns.map((column) => `${column} = ?`),
        ].join(", ")}
      WHERE id = ?
    `).run(...runValues).changes;
  }

  const updateLog = db.prepare("UPDATE agent_logs SET events = ? WHERE id = ?");
  for (const [index, row] of (plan.logs || []).entries()) {
    const original = related.logs[index];
    const events = serializedJson(row.events, []);
    if (original && events !== original.events) changes += updateLog.run(events, original.id).changes;
  }
  const updateComment = db.prepare("UPDATE task_comments SET body = ? WHERE id = ?");
  for (const [index, row] of (plan.comments || []).entries()) {
    const original = related.comments[index];
    const body = row.body ?? "[redacted]";
    if (original && body !== original.body) changes += updateComment.run(body, original.id).changes;
  }
  const updateCompaction = db.prepare("UPDATE run_compactions SET summary = ?, metadata_json = ?, error_text = ? WHERE id = ?");
  for (const [index, row] of (plan.compactions || []).entries()) {
    const original = related.compactions[index];
    const summary = row.summary || "";
    const metadataJson = serializedJson(row.metadata_json, {});
    const errorText = row.error_text ?? null;
    if (summary !== original?.summary || metadataJson !== original?.metadata_json || errorText !== original?.error_text) {
      changes += updateCompaction.run(summary, metadataJson, errorText, original.id).changes;
    }
  }
  const updateInteraction = db.prepare(`
    UPDATE acp_interactions
    SET protocol_request_id = ?, request_schema_json = ?, disposition = ?
    WHERE id = ?
  `);
  for (const [index, row] of (plan.interactions || []).entries()) {
    const original = related.interactions[index];
    const protocolRequestId = row.protocolRequestId === original?.protocol_request_id
      ? original.protocol_request_id
      : `legacy-redacted:${original.id}`;
    const requestSchemaJson = serializedJson(row.request_schema_json, {});
    const disposition = row.disposition ?? null;
    if (protocolRequestId !== original?.protocol_request_id
      || requestSchemaJson !== original?.request_schema_json
      || disposition !== original?.disposition) {
      changes += updateInteraction.run(protocolRequestId, requestSchemaJson, disposition, original.id).changes;
    }
  }
  if (related.embeddings.length > 0) {
    const ftsTriggerBacked = !!db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'embeddings'
        AND lower(sql) LIKE '%embeddings_fts%'
      LIMIT 1
    `).get();
    const deleteFts = !ftsTriggerBacked && tableExists(db, "embeddings_fts")
      ? db.prepare("DELETE FROM embeddings_fts WHERE id = ?")
      : null;
    const deleteEmbedding = db.prepare("DELETE FROM embeddings WHERE id = ?");
    for (const embedding of related.embeddings) {
      deleteFts?.run(embedding.id);
      changes += deleteEmbedding.run(embedding.id).changes;
    }
  }
  return changes;
}

function scrubAcpProfileProbeData(db) {
  if (!hasColumn(db, "acp_profiles", "last_probe_result_json")) return 0;
  const rows = db.prepare(`
    SELECT id, last_probe_result_json, last_probe_error_json
    FROM acp_profiles ORDER BY rowid ASC
  `).all();
  const update = db.prepare(`
    UPDATE acp_profiles
    SET last_probe_result_json = ?, last_probe_error_json = ?
    WHERE id = ?
  `);
  let changes = 0;
  for (const row of rows) {
    const boundary = createAcpEventPrivacyBoundary({ profileId: row.id, failureValue: null });
    const prepared = {
      result: parseJson(row.last_probe_result_json, {}).value,
      error: parseJson(row.last_probe_error_json, {}).value,
      legacySessionSeeds: [
        ...explicitSessionSeeds(row.last_probe_result_json),
        ...explicitSessionSeeds(row.last_probe_error_json),
      ],
    };
    const sanitized = boundary.sanitizeEvent(prepared) || { result: {}, error: {} };
    const resultJson = serializedJson(sanitized.result, {});
    const errorJson = serializedJson(sanitized.error, {});
    if (resultJson !== row.last_probe_result_json || errorJson !== row.last_probe_error_json) {
      changes += update.run(resultJson, errorJson, row.id).changes;
    }
  }
  return changes;
}

function scrubStandaloneAcpOperations(db) {
  if (!tableExists(db, "acp_operations")) return 0;
  const rows = db.prepare(`
    SELECT o.id, o.profile_id, o.remote_session_id,
           o.request_json, o.result_json, o.error_json
    FROM acp_operations o
    ORDER BY o.rowid ASC
  `).all();
  const updateOperation = db.prepare(`
    UPDATE acp_operations
    SET remote_session_id = ?, request_json = ?, result_json = ?, error_json = ?
    WHERE id = ?
  `);
  const updateInteraction = db.prepare(`
    UPDATE acp_interactions
    SET protocol_request_id = ?, request_schema_json = ?, disposition = ?
    WHERE id = ?
  `);
  let changes = 0;
  for (const row of rows) {
    const interactions = db.prepare(`
      SELECT id, protocol_request_id, request_schema_json, disposition
      FROM acp_interactions
      WHERE operation_id = ? AND task_run_id IS NULL
      ORDER BY rowid ASC
    `).all(row.id);
    const seeds = [
      ...explicitSessionSeeds(row.request_json),
      ...explicitSessionSeeds(row.result_json),
      ...explicitSessionSeeds(row.error_json),
    ];
    const prepared = {
      providerSessionId: row.remote_session_id,
      request: parseJson(row.request_json, {}).value,
      result: parseJson(row.result_json, {}).value,
      error: parseJson(row.error_json, {}).value,
      interactions: interactions.map((interaction) => {
        seeds.push(...explicitSessionSeeds(interaction.request_schema_json));
        return {
          protocolRequestId: interaction.protocol_request_id,
          requestSchema: parseJson(interaction.request_schema_json, {}).value,
          disposition: interaction.disposition,
        };
      }),
      legacySessionSeeds: seeds,
    };
    const boundary = createAcpEventPrivacyBoundary({
      profileId: row.profile_id,
      failureValue: null,
      includeCursors: true,
    });
    const sanitized = boundary.sanitizeEvent(prepared) || {
      providerSessionId: validateAcpProviderSessionId(row.remote_session_id, row.profile_id),
      request: {},
      result: {},
      error: {},
      interactions: interactions.map(() => ({
        protocolRequestId: null,
        requestSchema: {},
        disposition: null,
      })),
    };
    const remoteSessionId = sanitized.providerSessionId || null;
    const requestJson = serializedJson(sanitized.request, {});
    const resultJson = serializedJson(sanitized.result, {});
    const errorJson = serializedJson(sanitized.error, {});
    const transaction = db.transaction(() => {
      if (remoteSessionId !== (row.remote_session_id || null)
        || requestJson !== row.request_json
        || resultJson !== row.result_json
        || errorJson !== row.error_json) {
        changes += updateOperation.run(remoteSessionId, requestJson, resultJson, errorJson, row.id).changes;
      }
      for (const [index, interaction] of (sanitized.interactions || []).entries()) {
        const original = interactions[index];
        const protocolRequestId = interaction.protocolRequestId === original?.protocol_request_id
          ? original.protocol_request_id
          : `legacy-redacted:${original.id}`;
        const requestSchemaJson = serializedJson(interaction.requestSchema, {});
        const disposition = interaction.disposition ?? null;
        if (protocolRequestId !== original.protocol_request_id
          || requestSchemaJson !== original.request_schema_json
          || disposition !== original.disposition) {
          changes += updateInteraction.run(
            protocolRequestId,
            requestSchemaJson,
            disposition,
            original.id,
          ).changes;
        }
      }
    });
    transaction();
  }
  return changes;
}

/**
 * Remove raw protocol session identifiers written by pre-boundary ACP task
 * runs. The same bounded privacy primitive used by live event sinks performs
 * recursive key removal and copied-value redaction. Raw log replacement is
 * atomic and restricted to the database's configured data directory.
 */
export function scrubLegacyAcpSessionData(db) {
  if (!tableExists(db, "task_runs") || !tableExists(db, "acp_profiles")) {
    return { databaseChanged: false, filesChanged: 0 };
  }
  const jsonColumns = jsonColumnsForRun(db);
  const textColumns = RUN_TEXT_COLUMNS.filter((column) => hasColumn(db, "task_runs", column));
  const runs = acpRuns(db, jsonColumns, textColumns);
  const dataDir = databaseDataDir(db);
  let databaseChanges = 0;
  let filesChanged = 0;
  const previousSecureDelete = db.pragma("secure_delete", { simple: true });
  db.pragma("secure_delete = ON");
  try {
    for (const run of runs) {
      const profileId = profileIdForRun(run);
      const related = relatedRows(db, run);
      const rawLog = rawLogForRun(run.raw_output_path, dataDir);
      const boundary = createAcpEventPrivacyBoundary({ profileId, failureValue: null });
      const prepared = preparedRunValue(run, jsonColumns, textColumns, related, rawLog);
      const sanitized = rawLog.forceFailure ? null : boundary.sanitizeEvent(prepared);
      const plan = sanitized || failedClosedValue(run, jsonColumns, textColumns, related, rawLog, profileId);
      if (rawLog.detach) plan.rawOutputPath = null;
      filesChanged += rewriteRawLog(rawLog, plan.rawEvents) ? 1 : 0;
      const transaction = db.transaction(() => {
        databaseChanges += applyRunPlan(db, run, plan, jsonColumns, textColumns, related);
      });
      transaction();
    }
    databaseChanges += scrubAcpProfileProbeData(db);
    databaseChanges += scrubStandaloneAcpOperations(db);
  } finally {
    db.pragma(`secure_delete = ${Number(previousSecureDelete) || 0}`);
  }
  return { databaseChanged: databaseChanges > 0, filesChanged };
}

function truncateWal(db) {
  const journalMode = String(db.pragma("journal_mode", { simple: true }) || "").toLowerCase();
  if (journalMode !== "wal") return;
  const result = db.pragma("wal_checkpoint(TRUNCATE)")[0];
  if (Number(result?.busy) > 0) throw new Error("ACP privacy migration could not exclusively checkpoint the SQLite WAL");
}

/** Compact outside the scrub transaction so replaced cell contents cannot
 * remain in SQLite free pages or the WAL. The marker makes the unconditional
 * first-upgrade compaction one-shot; any later scrubbed row compacts again. */
export function compactLegacyAcpTaskRunData(db, { databaseChanged = false } = {}) {
  const compacted = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(ACP_PRIVACY_COMPACTION_KEY)?.value === "1";
  if (compacted && !databaseChanged) return false;
  if (db.inTransaction) throw new Error("ACP privacy compaction must run outside a transaction");
  truncateWal(db);
  db.exec("VACUUM");
  truncateWal(db);
  db.prepare(`
    INSERT INTO schema_meta (key, value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(ACP_PRIVACY_COMPACTION_KEY);
  truncateWal(db);
  return true;
}
