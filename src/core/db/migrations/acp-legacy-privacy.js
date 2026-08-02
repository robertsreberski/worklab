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
import { normalizeAcpPaginationCursorKey } from "../../acp-session-cursors.js";
import { runLogPathInsideDataDir } from "../../run-event-store.js";
import {
  addGlobalPrivateValue,
  addOwnedPrivateValues,
  collectPrivateValuesFromObject,
  collectPrivateValuesFromText,
  createPrivateValueScope,
  finalizePrivateValueScope,
} from "./acp-legacy-private-values.js";

const ACP_PRIVACY_COMPACTION_KEY = "acp_legacy_session_privacy_compacted_v1";
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_RAW_LOG_BYTES = 16 * 1024 * 1024;
const GLOBAL_PRIVATE_VALUE_BATCH_SIZE = 96;
const GLOBAL_PRIVACY_PROFILE_ID = "legacy-acp-global-copy";
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
const TASK_JSON_DEFAULTS = new Map([
  ["goal_contract_json", {}],
  ["pending_actions_json", []],
  ["pending_questions_json", []],
  ["blocking_issues_json", []],
]);
const TASK_TEXT_COLUMNS = [
  "goal_status_reason",
  "stage_reason",
  "plan_body",
  "error_text",
];
const EXPLICIT_PRIVATE_VALUE_RE = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/gu;
const EXPLICIT_SESSION_KEYS = new Set([
  "sessionId",
  "session_id",
  "providerSessionId",
  "provider_session_id",
]);
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

function tableHasRows(db, table, where = "") {
  if (!tableExists(db, table)) return false;
  return Boolean(db.prepare(`SELECT 1 FROM ${table} ${where} LIMIT 1`).get());
}

function hasLegacyAcpFootprint(db, runs = []) {
  if (runs.length > 0) return true;
  if (tableHasRows(db, "acp_profiles")
    || tableHasRows(db, "acp_operations")
    || tableHasRows(db, "acp_interactions")) return true;
  return tableHasRows(
    db,
    "agents",
    "WHERE sdk = 'acp' OR execution_mode = 'acp' OR model LIKE 'acp:%'",
  );
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
  for (const match of String(text || "").matchAll(EXPLICIT_PRIVATE_VALUE_RE)) {
    try {
      const key = JSON.parse(`"${match[1]}"`);
      if (!EXPLICIT_SESSION_KEYS.has(key) && !normalizeAcpPaginationCursorKey(key)) continue;
      seeds.push({ [key]: JSON.parse(`"${match[2]}"`) });
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

function collectGlobalAcpPrivateValues(db, runs, jsonColumns, dataDir) {
  const scope = createPrivateValueScope();
  if (tableExists(db, "acp_operations")) {
    const operations = db.prepare(`
      SELECT profile_id, kind, remote_session_id, request_json, result_json, error_json
      FROM acp_operations ORDER BY rowid ASC
    `).all();
    for (const operation of operations) {
      const values = new Set();
      addGlobalPrivateValue(values, operation.remote_session_id, { provider: true });
      for (const column of ["request_json", "result_json", "error_json"]) {
        collectPrivateValuesFromText(operation[column], values, {
          includeCursors: operation.kind === "list_sessions",
        });
      }
      addOwnedPrivateValues(scope, values, { profileId: operation.profile_id });
    }
  }

  if (tableExists(db, "acp_profiles") && hasColumn(db, "acp_profiles", "last_probe_result_json")) {
    const profiles = db.prepare(`
      SELECT id, last_probe_result_json, last_probe_error_json
      FROM acp_profiles ORDER BY rowid ASC
    `).all();
    for (const profile of profiles) {
      const values = new Set();
      collectPrivateValuesFromText(profile.last_probe_result_json, values);
      collectPrivateValuesFromText(profile.last_probe_error_json, values);
      addOwnedPrivateValues(scope, values, { profileId: profile.id });
    }
  }

  for (const run of runs) {
    const values = new Set();
    addGlobalPrivateValue(values, run.provider_session_id, { provider: true });
    for (const column of jsonColumns) {
      collectPrivateValuesFromText(run[column], values, { includeCursors: true });
    }
    const related = relatedRows(db, run);
    for (const log of related.logs) {
      collectPrivateValuesFromText(log.events, values, { includeCursors: true });
    }
    for (const compaction of related.compactions) {
      collectPrivateValuesFromText(compaction.metadata_json, values, { includeCursors: true });
    }
    for (const interaction of related.interactions) {
      collectPrivateValuesFromText(interaction.request_schema_json, values, { includeCursors: true });
    }
    const rawLog = rawLogForRun(run.raw_output_path, dataDir);
    for (const event of rawLog.events) {
      collectPrivateValuesFromObject(event, values, { includeCursors: true });
    }
    for (const seed of rawLog.seeds) {
      collectPrivateValuesFromObject(seed, values, { includeCursors: true });
    }
    addOwnedPrivateValues(scope, values, {
      runId: run.id,
      taskId: run.task_id,
    });
  }
  return finalizePrivateValueScope(scope);
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

function serializedContainsPrivateValue(value, privateValues) {
  const text = String(value ?? "");
  return privateValues.some((privateValue) => {
    if (text.includes(privateValue)) return true;
    const escaped = JSON.stringify(privateValue).slice(1, -1);
    return escaped !== privateValue && text.includes(escaped);
  });
}

function sanitizePrivateCopies(value, privateValues, failureValue, profileId = GLOBAL_PRIVACY_PROFILE_ID) {
  let sanitized = value;
  for (let offset = 0; offset < privateValues.length; offset += GLOBAL_PRIVATE_VALUE_BATCH_SIZE) {
    const batch = privateValues.slice(offset, offset + GLOBAL_PRIVATE_VALUE_BATCH_SIZE);
    const boundary = createAcpEventPrivacyBoundary({
      profileId,
      failureValue: null,
    });
    const wrapped = boundary.sanitizeEvent([
      batch.map((privateValue) => ({ sessionId: privateValue })),
      sanitized,
    ]);
    if (!Array.isArray(wrapped)) return failureValue;
    sanitized = wrapped[1];
  }
  return sanitized;
}

function scrubPrivateText(value, privateValues, fallback = "[redacted]") {
  if (value == null || !serializedContainsPrivateValue(value, privateValues)) return value;
  return sanitizePrivateCopies(String(value), privateValues, fallback);
}

function scrubPrivateJson(value, privateValues, fallback, profileId = GLOBAL_PRIVACY_PROFILE_ID) {
  if (value == null || !serializedContainsPrivateValue(value, privateValues)) return value;
  const parsed = parseJson(value, fallback);
  if (!parsed.valid) return serializedJson(fallback, fallback);
  return serializedJson(
    sanitizePrivateCopies(parsed.value, privateValues, fallback, profileId),
    fallback,
  );
}

function embeddingReferencesMemory(row, memoryIds) {
  if (!memoryIds.size) return false;
  for (const value of [row.ref, row.source_ref]) {
    const segments = referenceSegments(value);
    if (segments.some((segment) => memoryIds.has(segment))) return true;
  }
  return false;
}

function deleteEmbeddingRows(db, rows) {
  if (!rows.length) return 0;
  const ftsTriggerBacked = !!db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'embeddings'
      AND lower(sql) LIKE '%embeddings_fts%'
    LIMIT 1
  `).get();
  const deleteFts = !ftsTriggerBacked && tableExists(db, "embeddings_fts")
    ? db.prepare("DELETE FROM embeddings_fts WHERE id = ?")
    : null;
  const remove = db.prepare("DELETE FROM embeddings WHERE id = ?");
  let changes = 0;
  for (const row of rows) {
    deleteFts?.run(row.id);
    changes += remove.run(row.id).changes;
  }
  return changes;
}

function globallyDistinctivePrivateValue(value) {
  if (value.length < 24) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u]
    .filter((pattern) => pattern.test(value)).length;
  return classes >= 3 || (value.length >= 32 && classes >= 2) || value.length >= 48;
}

function ownedPrivateValues(privateScope, map, key) {
  const values = [
    ...privateScope.all.filter(globallyDistinctivePrivateValue),
    ...(map.get(key) || []),
  ];
  return [...new Set(values)].sort((left, right) => right.length - left.length);
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

function scrubDurableAcpPrivateCopies(db, runs, privateScope) {
  if (!privateScope.all.length) return 0;
  const globallyDistinctive = privateScope.all.filter(globallyDistinctivePrivateValue);
  const runIds = new Set(runs.map((run) => run.id));
  const runProfiles = new Map(runs.map((run) => [run.id, profileIdForRun(run)]));
  const taskIds = new Set(runs.map((run) => run.task_id).filter(Boolean));
  const linkedCommentIds = new Set();
  let changes = 0;

  const transaction = db.transaction(() => {
    if (tableExists(db, "tasks")) {
      const jsonColumns = [...TASK_JSON_DEFAULTS.keys()].filter((column) => hasColumn(db, "tasks", column));
      const textColumns = TASK_TEXT_COLUMNS.filter((column) => hasColumn(db, "tasks", column));
      const columns = [...jsonColumns, ...textColumns];
      if (columns.length) {
        const update = db.prepare(`
          UPDATE tasks SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?
        `);
        for (const row of db.prepare(`SELECT id, ${columns.join(", ")} FROM tasks`).all()) {
          const values = taskIds.has(row.id)
            ? ownedPrivateValues(privateScope, privateScope.byTask, row.id)
            : globallyDistinctive;
          if (!values.length) continue;
          const scrubbed = [
            ...jsonColumns.map((column) => scrubPrivateJson(row[column], values, TASK_JSON_DEFAULTS.get(column))),
            ...textColumns.map((column) => scrubPrivateText(row[column], values)),
          ];
          if (columns.some((column, index) => scrubbed[index] !== row[column])) {
            changes += update.run(...scrubbed, row.id).changes;
          }
        }
      }
    }

    if (tableExists(db, "task_comments") && hasColumn(db, "task_comments", "body")) {
      const update = db.prepare("UPDATE task_comments SET body = ? WHERE id = ?");
      for (const row of db.prepare("SELECT id, task_id, body FROM task_comments").all()) {
        const linked = taskIds.has(row.task_id);
        if (linked) linkedCommentIds.add(row.id);
        const values = linked
          ? ownedPrivateValues(privateScope, privateScope.byTask, row.task_id)
          : globallyDistinctive;
        const body = scrubPrivateText(row.body, values);
        if (body !== row.body) changes += update.run(body, row.id).changes;
      }
    }

    if (tableExists(db, "task_runs")) {
      const jsonColumns = [...RUN_JSON_DEFAULTS.keys()].filter((column) => hasColumn(db, "task_runs", column));
      const textColumns = RUN_TEXT_COLUMNS.filter((column) => hasColumn(db, "task_runs", column));
      const columns = [...jsonColumns, ...textColumns];
      if (columns.length) {
        const update = db.prepare(`
          UPDATE task_runs SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?
        `);
        for (const row of db.prepare(`SELECT id, ${columns.join(", ")} FROM task_runs`).all()) {
          const values = runIds.has(row.id)
            ? ownedPrivateValues(privateScope, privateScope.byRun, row.id)
            : globallyDistinctive;
          if (!values.length) continue;
          const scrubbed = [
            ...jsonColumns.map((column) => scrubPrivateJson(
              row[column],
              values,
              RUN_JSON_DEFAULTS.get(column),
              runProfiles.get(row.id),
            )),
            ...textColumns.map((column) => scrubPrivateText(row[column], values)),
          ];
          if (columns.some((column, index) => scrubbed[index] !== row[column])) {
            changes += update.run(...scrubbed, row.id).changes;
          }
        }
      }
    }

    if (tableExists(db, "agent_logs") && hasColumn(db, "agent_logs", "events")) {
      const update = db.prepare("UPDATE agent_logs SET events = ? WHERE id = ?");
      for (const row of db.prepare("SELECT id, task_run_id, events FROM agent_logs").all()) {
        const values = runIds.has(row.task_run_id)
          ? ownedPrivateValues(privateScope, privateScope.byRun, row.task_run_id)
          : globallyDistinctive;
        const events = scrubPrivateJson(
          row.events,
          values,
          [],
          runProfiles.get(row.task_run_id),
        );
        if (events !== row.events) changes += update.run(events, row.id).changes;
      }
    }

    if (tableExists(db, "run_compactions")) {
      const update = db.prepare(`
        UPDATE run_compactions SET summary = ?, metadata_json = ?, error_text = ? WHERE id = ?
      `);
      for (const row of db.prepare(`
        SELECT id, task_run_id, summary, metadata_json, error_text FROM run_compactions
      `).all()) {
        const values = runIds.has(row.task_run_id)
          ? ownedPrivateValues(privateScope, privateScope.byRun, row.task_run_id)
          : globallyDistinctive;
        const scrubbed = {
          summary: scrubPrivateText(row.summary, values),
          metadata: scrubPrivateJson(
            row.metadata_json,
            values,
            {},
            runProfiles.get(row.task_run_id),
          ),
          error: scrubPrivateText(row.error_text, values),
        };
        if (scrubbed.summary !== row.summary
          || scrubbed.metadata !== row.metadata_json
          || scrubbed.error !== row.error_text) {
          changes += update.run(scrubbed.summary, scrubbed.metadata, scrubbed.error, row.id).changes;
        }
      }
    }

    if (tableExists(db, "acp_profiles") && hasColumn(db, "acp_profiles", "last_probe_result_json")) {
      const update = db.prepare(`
        UPDATE acp_profiles SET last_probe_result_json = ?, last_probe_error_json = ? WHERE id = ?
      `);
      for (const row of db.prepare(`
        SELECT id, last_probe_result_json, last_probe_error_json FROM acp_profiles
      `).all()) {
        const values = ownedPrivateValues(privateScope, privateScope.byProfile, row.id);
        const result = scrubPrivateJson(row.last_probe_result_json, values, {}, row.id);
        const error = scrubPrivateJson(row.last_probe_error_json, values, {}, row.id);
        if (result !== row.last_probe_result_json || error !== row.last_probe_error_json) {
          changes += update.run(result, error, row.id).changes;
        }
      }
    }

    if (tableExists(db, "acp_operations")) {
      const update = db.prepare(`
        UPDATE acp_operations SET request_json = ?, result_json = ?, error_json = ? WHERE id = ?
      `);
      for (const row of db.prepare(`
        SELECT id, profile_id, request_json, result_json, error_json FROM acp_operations
      `).all()) {
        const values = ownedPrivateValues(privateScope, privateScope.byProfile, row.profile_id);
        const request = scrubPrivateJson(row.request_json, values, {}, row.profile_id);
        const result = scrubPrivateJson(row.result_json, values, {}, row.profile_id);
        const error = scrubPrivateJson(row.error_json, values, {}, row.profile_id);
        if (request !== row.request_json || result !== row.result_json || error !== row.error_json) {
          changes += update.run(request, result, error, row.id).changes;
        }
      }
    }

    if (tableExists(db, "acp_interactions")) {
      const update = db.prepare(`
        UPDATE acp_interactions
        SET protocol_request_id = ?, request_schema_json = ?, disposition = ?
        WHERE id = ?
      `);
      for (const row of db.prepare(`
        SELECT id, profile_id, protocol_request_id, request_schema_json, disposition FROM acp_interactions
      `).all()) {
        const values = ownedPrivateValues(privateScope, privateScope.byProfile, row.profile_id);
        const protocolRequestId = scrubPrivateText(row.protocol_request_id, values);
        const requestSchema = scrubPrivateJson(
          row.request_schema_json,
          values,
          {},
          row.profile_id,
        );
        const disposition = scrubPrivateText(row.disposition, values);
        if (protocolRequestId !== row.protocol_request_id
          || requestSchema !== row.request_schema_json
          || disposition !== row.disposition) {
          changes += update.run(
            protocolRequestId,
            requestSchema,
            disposition,
            row.id,
          ).changes;
        }
      }
    }

    if (tableExists(db, "task_run_approvals")) {
      const update = db.prepare(`
        UPDATE task_run_approvals SET arguments_summary = ?, model = ?, reason = ? WHERE id = ?
      `);
      for (const row of db.prepare(`
        SELECT id, task_run_id, arguments_summary, model, reason FROM task_run_approvals
      `).all()) {
        if (!runIds.has(row.task_run_id)) continue;
        const values = ownedPrivateValues(privateScope, privateScope.byRun, row.task_run_id);
        const summary = scrubPrivateText(row.arguments_summary, values);
        const model = scrubPrivateText(row.model, values);
        const reason = scrubPrivateText(row.reason, values);
        if (summary !== row.arguments_summary || model !== row.model || reason !== row.reason) {
          changes += update.run(summary, model, reason, row.id).changes;
        }
      }
    }

    if (tableExists(db, "slack_delivery_log")) {
      const update = db.prepare(`
        UPDATE slack_delivery_log SET text = ?, error_text = ?, response_json = ? WHERE id = ?
      `);
      for (const row of db.prepare(`
        SELECT id, task_run_id, text, error_text, response_json FROM slack_delivery_log
      `).all()) {
        if (!runIds.has(row.task_run_id)) continue;
        const values = ownedPrivateValues(privateScope, privateScope.byRun, row.task_run_id);
        const text = scrubPrivateText(row.text, values);
        const error = scrubPrivateText(row.error_text, values);
        const response = scrubPrivateJson(row.response_json, values, {});
        if (text !== row.text || error !== row.error_text || response !== row.response_json) {
          changes += update.run(text, error, response, row.id).changes;
        }
      }
    }

    const memoryIds = new Set();
    if (tableExists(db, "agent_memories")) {
      for (const row of db.prepare("SELECT id, run_id, task_id FROM agent_memories").all()) {
        if (runIds.has(row.run_id) || taskIds.has(row.task_id)) memoryIds.add(row.id);
      }
    }

    if (tableExists(db, "embeddings")) {
      const rows = db.prepare(`
        SELECT id, kind, ref, source_ref, agent, title, chunk_text, model, content_hash, indexing_error
        FROM embeddings ORDER BY rowid ASC
      `).all();
      const remove = rows.filter((row) => {
        const linkedTask = referenceLinksEntity(
          row.source_ref,
          taskIds,
          TASK_REFERENCE_SEGMENTS,
          row.kind,
        ) || referenceLinksEntity(row.ref, taskIds, TASK_REFERENCE_SEGMENTS, row.kind);
        const linkedComment = referenceLinksEntity(
          row.source_ref,
          linkedCommentIds,
          COMMENT_REFERENCE_SEGMENTS,
          row.kind,
        ) || referenceLinksEntity(row.ref, linkedCommentIds, COMMENT_REFERENCE_SEGMENTS, row.kind);
        const copiedGlobalValue = [
          row.ref,
          row.source_ref,
          row.agent,
          row.title,
          row.chunk_text,
          row.model,
          row.content_hash,
          row.indexing_error,
        ].some((value) => serializedContainsPrivateValue(value, globallyDistinctive));
        return linkedTask
          || linkedComment
          || embeddingReferencesMemory(row, memoryIds)
          || copiedGlobalValue;
      });
      changes += deleteEmbeddingRows(db, remove);
    }

    if (memoryIds.size) {
      const remove = db.prepare("DELETE FROM agent_memories WHERE id = ?");
      for (const id of memoryIds) changes += remove.run(id).changes;
    }
  });
  transaction();
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
    return {
      databaseChanged: false,
      filesChanged: 0,
      legacyFootprint: hasLegacyAcpFootprint(db),
    };
  }
  const jsonColumns = jsonColumnsForRun(db);
  const textColumns = RUN_TEXT_COLUMNS.filter((column) => hasColumn(db, "task_runs", column));
  const runs = acpRuns(db, jsonColumns, textColumns);
  const legacyFootprint = hasLegacyAcpFootprint(db, runs);
  const dataDir = databaseDataDir(db);
  const privateScope = collectGlobalAcpPrivateValues(db, runs, jsonColumns, dataDir);
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
      plan.rawEvents = sanitizePrivateCopies(
        plan.rawEvents,
        ownedPrivateValues(privateScope, privateScope.byRun, run.id),
        [LEGACY_PRIVACY_EVENT],
        profileId,
      );
      if (rawLog.detach) plan.rawOutputPath = null;
      filesChanged += rewriteRawLog(rawLog, plan.rawEvents) ? 1 : 0;
      const transaction = db.transaction(() => {
        databaseChanges += applyRunPlan(db, run, plan, jsonColumns, textColumns, related);
      });
      transaction();
    }
    databaseChanges += scrubAcpProfileProbeData(db);
    databaseChanges += scrubStandaloneAcpOperations(db);
    databaseChanges += scrubDurableAcpPrivateCopies(db, runs, privateScope);
  } finally {
    db.pragma(`secure_delete = ${Number(previousSecureDelete) || 0}`);
  }
  return { databaseChanged: databaseChanges > 0, filesChanged, legacyFootprint };
}

function truncateWal(db) {
  const journalMode = String(db.pragma("journal_mode", { simple: true }) || "").toLowerCase();
  if (journalMode !== "wal") return;
  const result = db.pragma("wal_checkpoint(TRUNCATE)")[0];
  if (Number(result?.busy) > 0) throw new Error("ACP privacy migration could not exclusively checkpoint the SQLite WAL");
}

/** Compact outside the scrub transaction so replaced cell contents cannot
 * remain in SQLite free pages or the WAL. The marker makes the first ACP-
 * footprint compaction one-shot; databases with no legacy ACP footprint only
 * need the marker, while any later scrubbed row compacts again. */
export function compactLegacyAcpTaskRunData(db, {
  databaseChanged = false,
  legacyFootprint = false,
} = {}) {
  const compacted = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(ACP_PRIVACY_COMPACTION_KEY)?.value === "1";
  if (compacted && !databaseChanged) return false;
  if (db.inTransaction) throw new Error("ACP privacy compaction must run outside a transaction");
  if (!databaseChanged && !legacyFootprint) {
    db.prepare(`
      INSERT INTO schema_meta (key, value) VALUES (?, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(ACP_PRIVACY_COMPACTION_KEY);
    return false;
  }
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
