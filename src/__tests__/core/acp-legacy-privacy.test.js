import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";

const PROFILE_ID = "00000000-0000-4000-8000-000000000001";

function opaqueSessionId(raw) {
  return `acp:v1:${PROFILE_ID}:${Buffer.from(raw).toString("base64url")}`;
}

function insertAcpFixture(db, now = Date.now()) {
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, execution_mode, created_at, updated_at)
    VALUES ('external', 'External', 'acp', ?, 'acp', ?, ?)
  `).run(`acp:${PROFILE_ID}`, now, now);
  db.prepare(`
    INSERT INTO acp_profiles (
      id, agent_name, driver, command, args_json, env_keys_json,
      configuration_owner, workspace_owner, mcp_owner, created_at, updated_at
    ) VALUES (?, 'external', 'generic', ?, '[]', '[]', 'client', 'client', 'client', ?, ?)
  `).run(PROFILE_ID, process.execPath, now, now);
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('task-acp', 'ACP task', ?, ?)")
    .run(now, now);
}

function databaseContains(path, value) {
  if (!existsSync(path)) return false;
  return readFileSync(path).includes(Buffer.from(value));
}

describe("legacy ACP session privacy migration", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("marks a non-ACP upgrade without vacuuming the existing database", () => {
    const db = openDb(":memory:");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('version', '48');
      CREATE TABLE legacy_payload (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      INSERT INTO legacy_payload (body) VALUES (printf('%.*c', 100000, 'x'));
    `);
    const exec = vi.spyOn(db, "exec");

    runMigrations(db);

    expect(exec.mock.calls.map(([sql]) => String(sql).trim().toUpperCase())).not.toContain("VACUUM");
    expect(db.prepare("SELECT value FROM schema_meta WHERE key = 'acp_legacy_session_privacy_compacted_v1'").get())
      .toEqual({ value: "1" });
    expect(db.prepare("SELECT length(body) AS length FROM legacy_payload").get().length).toBe(100000);
    db.close();
  });

  it("vacuum-compacts a preexisting ACP schema after its last live row was deleted", () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-acp-deleted-privacy-"));
    roots.push(root);
    const dbPath = join(root, "worklab.db");
    const sentinel = "RAW_DELETED_ACP_SECRET_493827_";
    const rawSession = sentinel.repeat(512);
    const db = openDb(dbPath);
    runMigrations(db);
    db.pragma("secure_delete = OFF");
    insertAcpFixture(db);
    db.prepare(`
      UPDATE acp_profiles
      SET last_probe_result_json = ?
      WHERE id = ?
    `).run(JSON.stringify({ sessionId: rawSession, copied: rawSession }), PROFILE_ID);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.prepare("DELETE FROM acp_profiles WHERE id = ?").run(PROFILE_ID);
    db.prepare("DELETE FROM agents WHERE name = 'external'").run();
    db.prepare("DELETE FROM schema_meta WHERE key = 'acp_legacy_session_privacy_compacted_v1'").run();
    db.prepare("UPDATE schema_meta SET value = '48' WHERE key = 'version'").run();
    db.pragma("wal_checkpoint(TRUNCATE)");

    expect(databaseContains(dbPath, sentinel)).toBe(true);
    runMigrations(db);

    expect(databaseContains(dbPath, sentinel)).toBe(false);
    expect(databaseContains(`${dbPath}-wal`, sentinel)).toBe(false);
    expect(db.prepare("SELECT value FROM schema_meta WHERE key = 'acp_legacy_session_privacy_compacted_v1'").get())
      .toEqual({ value: "1" });
    db.close();
  });

  it("scrubs historical ACP rows, copied values, and raw JSONL while preserving opaque and non-ACP sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-acp-privacy-"));
    roots.push(root);
    const dataDir = join(root, "data");
    mkdirSync(join(dataDir, "logs", "runs"), { recursive: true });
    const dbPath = join(dataDir, "worklab.db");
    const rawPath = join(dataDir, "logs", "runs", "run-raw.jsonl");
    const rawSession = "RAW_ACP_SESSION_SENTINEL";
    const handleOnlySession = "RAW_FROM_VALID_HANDLE";
    const malformedLineSession = "RAW_FROM_MALFORMED_LINE";
    const malformedProviderId = "RAW_MALFORMED_PROVIDER_ID";
    const operationSession = "RAW_OPERATION_SESSION";
    const invalidOperationSession = "RAW_INVALID_OPERATION_SESSION";
    const probeSession = "RAW_PROFILE_PROBE_SESSION";
    const rawCursor = "RAW_CURSOR_SECRET";
    const rawNextCursor = "RAW_NEXT_CURSOR_SECRET";
    const rawPageCursor = "RAW_PAGE_CURSOR_ALIAS_SECRET";
    const rawPageToken = "RAW_PAGE_TOKEN_ALIAS_SECRET_493827";
    const opaqueCursorRaw = "RAW_OPAQUE_CURSOR_COPY";
    const nonAcpSession = "NON_ACP_SESSION_MUST_SURVIVE";
    const providerSessionId = opaqueSessionId(handleOnlySession);
    const operationProviderSessionId = opaqueSessionId(operationSession);
    const opaqueCursor = `acp-cursor:v1:${PROFILE_ID}:${Buffer.from(opaqueCursorRaw).toString("base64url")}`;
    writeFileSync(rawPath, [
      JSON.stringify({
        type: "sdk_event",
        sessionId: rawSession,
        providerSessionId,
        message: `${rawSession} ${handleOnlySession} ${rawPageToken}`,
      }),
      `{"type":"partial","sessionId":"${malformedLineSession}"`,
      "",
    ].join("\n"), { mode: 0o600 });

    const db = openDb(dbPath);
    runMigrations(db);
    insertAcpFixture(db);
    db.prepare(`
      UPDATE acp_profiles
      SET last_probe_result_json = ?, last_probe_error_json = ?
      WHERE id = ?
    `).run(
      JSON.stringify({ sessionId: probeSession, copied: probeSession }),
      JSON.stringify({ message: probeSession }),
      PROFILE_ID,
    );
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status, process_status,
        started_at, error_text, raw_output_path, diagnostics_json,
        provider_session_id, transcript_tail_json
      ) VALUES ('run-raw', 'task-acp', 'execute', 'execute', 'external', 'acp',
        'complete', 'succeeded', 1, ?, ?, ?, ?, ?)
    `).run(
      `failed ${rawSession} ${malformedProviderId}`,
      rawPath,
      JSON.stringify({
        session_id: rawSession,
        providerSessionId: malformedProviderId,
        copied: `${rawSession} ${malformedProviderId}`,
      }),
      malformedProviderId,
      JSON.stringify([{ text: `${rawSession} ${malformedLineSession}` }]),
    );
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status, process_status,
        started_at, diagnostics_json, provider_session_id
      ) VALUES ('run-handle', 'task-acp', 'execute', 'execute', 'external', 'acp',
        'complete', 'succeeded', 2, ?, ?)
    `).run(JSON.stringify({ copied: handleOnlySession }), providerSessionId);
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status, process_status,
        started_at, diagnostics_json, provider_session_id
      ) VALUES ('run-bound', 'task-acp', 'execute', 'execute', 'external', NULL,
        'complete', 'succeeded', 3, ?, ?)
    `).run(JSON.stringify({ sessionId: rawSession, copied: rawSession }), rawSession);
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status, process_status,
        started_at, diagnostics_json, provider_session_id
      ) VALUES ('run-non-acp', 'task-acp', 'execute', 'execute', 'external', 'claude',
        'complete', 'succeeded', 4, ?, ?)
    `).run(JSON.stringify({ sessionId: nonAcpSession }), nonAcpSession);
    db.prepare(`
      UPDATE tasks
      SET plan_body = ?, error_text = ?, pending_actions_json = ?
      WHERE id = 'task-acp'
    `).run(
      `promoted ${rawPageToken}`,
      `promoted ${malformedProviderId}`,
      JSON.stringify([{ label: rawPageToken }]),
    );
    db.prepare(`
      INSERT INTO tasks (id, title, created_at, updated_at)
      VALUES ('task-unrelated-copy', 'Unrelated copy holder', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
      VALUES ('log-raw', 'run-raw', ?, 'complete', 1)
    `).run(JSON.stringify([{ type: "message", text: rawSession, session_id: rawSession }]));
    db.prepare(`
      INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
      VALUES ('log-handle', 'run-handle', ?, 'complete', 2)
    `).run(JSON.stringify([{ type: "message", text: handleOnlySession, provider_session_id: providerSessionId }]));
    db.prepare(`
      INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
      VALUES ('log-unrelated-copy', 'run-non-acp', ?, 'complete', 3)
    `).run(JSON.stringify([{ type: "message", text: `copied ${rawPageToken}` }]));
    db.prepare(`
      INSERT INTO task_comments (id, task_id, author_type, body, created_at)
      VALUES ('comment-acp', 'task-acp', 'system', ?, 1)
    `).run(`copied ${rawSession} ${handleOnlySession} ${malformedLineSession}`);
    db.prepare(`
      INSERT INTO task_comments (id, task_id, author_type, body, created_at)
      VALUES ('comment-unrelated-copy', 'task-unrelated-copy', 'system', ?, 2)
    `).run(`copied ${rawPageToken}`);
    db.prepare(`
      INSERT INTO run_compactions (
        id, task_run_id, seq, trigger, summary, metadata_json, error_text, created_at
      ) VALUES ('compact-acp', 'run-raw', 1, 'manual', ?, ?, ?, 1)
    `).run(rawSession, JSON.stringify({ sessionId: rawSession, copied: rawSession }), malformedProviderId);
    db.prepare(`
      INSERT INTO embeddings (
        id, kind, ref, source_ref, title, chunk_text, vector_present,
        content_hash, created_at, updated_at
      ) VALUES ('embedding-comment', 'task_comment', ?, ?, 'ACP comment', ?, 0, 'hash-comment', 1, 1)
    `).run(
      "tasks/task-acp/comments/comment-acp#chunk-0",
      "tasks/task-acp/comments/comment-acp#chunk-0",
      `copied ${rawSession}`,
    );
    db.prepare(`
      INSERT INTO embeddings_fts (id, kind, source_ref, title, chunk_text)
      VALUES ('embedding-comment', 'task_comment', ?, 'ACP comment', ?)
    `).run("tasks/task-acp/comments/comment-acp#chunk-0", `copied ${rawSession}`);
    db.prepare(`
      INSERT INTO embeddings (
        id, kind, ref, source_ref, title, chunk_text, vector_present,
        content_hash, created_at, updated_at
      ) VALUES (
        'embedding-unrelated', 'kb', 'knowledge/unrelated.md#chunk-0',
        'knowledge/unrelated.md#chunk-0', 'Unrelated', 'safe content', 0,
        'hash-unrelated', 1, 1
      )
    `).run();
    db.prepare(`
      INSERT INTO embeddings (
        id, kind, ref, source_ref, title, chunk_text, vector_present,
        content_hash, created_at, updated_at
      ) VALUES (
        'embedding-unrelated-copy', 'kb', 'knowledge/copy.md#chunk-0',
        'knowledge/copy.md#chunk-0', 'Copied cursor', ?, 0,
        'hash-unrelated-copy', 1, 1
      )
    `).run(`copied ${rawPageToken}`);
    db.prepare(`
      INSERT INTO embeddings_fts (id, kind, source_ref, title, chunk_text)
      VALUES (
        'embedding-unrelated-copy', 'kb', 'knowledge/copy.md#chunk-0',
        'Copied cursor', ?
      )
    `).run(`copied ${rawPageToken}`);
    db.prepare(`
      INSERT INTO agent_memories (
        id, agent_name, kind, scope, status, content, content_key, evidence,
        task_id, run_id, source, metadata_json, created_at, updated_at
      ) VALUES (
        'memory-acp-copy', 'external', 'learning', 'task', 'active', ?,
        'memory-acp-copy-key', ?, 'task-acp', 'run-raw', 'run', ?, 1, 1
      )
    `).run(
      `learned ${malformedProviderId}`,
      `evidence ${rawPageToken}`,
      JSON.stringify({ copied: rawPageCursor }),
    );
    db.prepare(`
      INSERT INTO embeddings (
        id, kind, ref, source_ref, title, chunk_text, vector_present,
        content_hash, created_at, updated_at
      ) VALUES (
        'embedding-memory-acp-copy', 'agent_memory',
        'agent_memories/memory-acp-copy', 'agent_memories/memory-acp-copy',
        'Memory', ?, 0, 'hash-memory-copy', 1, 1
      )
    `).run(`learned ${malformedProviderId}`);
    db.prepare(`
      INSERT INTO embeddings_fts (id, kind, source_ref, title, chunk_text)
      VALUES (
        'embedding-memory-acp-copy', 'agent_memory',
        'agent_memories/memory-acp-copy', 'Memory', ?
      )
    `).run(`learned ${malformedProviderId}`);
    db.prepare(`
      INSERT INTO embeddings_fts (id, kind, source_ref, title, chunk_text)
      VALUES (
        'embedding-unrelated', 'kb', 'knowledge/unrelated.md#chunk-0',
        'Unrelated', 'safe content'
      )
    `).run();
    db.prepare(`
      INSERT INTO acp_interactions (
        id, profile_id, task_run_id, protocol_request_id, kind,
        request_schema_json, state, disposition, created_at, updated_at
      ) VALUES ('interaction-acp', ?, 'run-raw', ?, 'form', ?, 'submitted', ?, 1, 1)
    `).run(
      PROFILE_ID,
      `request-${rawSession}`,
      JSON.stringify({ session_id: rawSession, description: rawSession }),
      `accepted ${rawSession}`,
    );
    db.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, remote_session_id, request_json,
        result_json, error_json, created_at, updated_at, completed_at
      ) VALUES ('operation-acp', ?, 'delete_session', 'succeeded', ?, ?, ?, ?, 1, 1, 1)
    `).run(
      PROFILE_ID,
      operationProviderSessionId,
      JSON.stringify({ providerSessionId: operationProviderSessionId, note: operationSession }),
      JSON.stringify({ copied: operationSession }),
      JSON.stringify({ message: operationSession }),
    );
    db.prepare(`
      INSERT INTO acp_interactions (
        id, profile_id, operation_id, protocol_request_id, kind,
        request_schema_json, state, disposition, created_at, updated_at
      ) VALUES ('interaction-operation', ?, 'operation-acp', ?, 'form', ?, 'submitted', ?, 1, 1)
    `).run(
      PROFILE_ID,
      `operation-request-${operationSession}`,
      JSON.stringify({ description: operationSession }),
      `accepted ${operationSession}`,
    );
    db.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, remote_session_id, request_json,
        result_json, error_json, created_at, updated_at, completed_at
      ) VALUES ('operation-invalid', ?, 'delete_session', 'failed', ?, ?, '{}', '{}', 2, 2, 2)
    `).run(
      PROFILE_ID,
      invalidOperationSession,
      JSON.stringify({ provider_session_id: invalidOperationSession, copied: invalidOperationSession }),
    );
    db.prepare(`
      INSERT INTO acp_interactions (
        id, profile_id, operation_id, protocol_request_id, kind,
        request_schema_json, state, created_at, updated_at
      ) VALUES ('interaction-ordinary', ?, 'operation-invalid', 'ordinary-request-id', 'form', '{}', 'submitted', 2, 2)
    `).run(PROFILE_ID);
    db.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json,
        error_json, created_at, updated_at, completed_at
      ) VALUES ('operation-raw-cursor', ?, 'list_sessions', 'succeeded', ?, ?, '{}', 3, 3, 3)
    `).run(
      PROFILE_ID,
      JSON.stringify({ cursor: rawCursor, copied: rawNextCursor }),
      JSON.stringify({ nextCursor: rawNextCursor, copied: `${rawCursor} ${rawNextCursor}` }),
    );
    db.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json,
        error_json, created_at, updated_at, completed_at
      ) VALUES ('operation-opaque-cursor', ?, 'list_sessions', 'succeeded', ?, ?, '{}', 4, 4, 4)
    `).run(
      PROFILE_ID,
      JSON.stringify({ cursor: opaqueCursor, copied: opaqueCursorRaw }),
      JSON.stringify({ nextCursor: opaqueCursor, copied: opaqueCursorRaw }),
    );
    db.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json,
        error_json, created_at, updated_at, completed_at
      ) VALUES ('operation-cursor-aliases', ?, 'list_sessions', 'succeeded', ?, ?, '{}', 5, 5, 5)
    `).run(
      PROFILE_ID,
      JSON.stringify({ pageCursor: rawPageCursor, copied: rawPageCursor }),
      JSON.stringify({
        "next-page-cursor": opaqueCursor,
        pageToken: rawPageToken,
        copied: `${opaqueCursorRaw} ${rawPageToken}`,
        [`key-${rawPageToken}`]: "value",
      }),
    );

    runMigrations(db);

    const rawRun = db.prepare(`
      SELECT provider_session_id, diagnostics_json, error_text, transcript_tail_json
      FROM task_runs WHERE id = 'run-raw'
    `).get();
    expect(rawRun.provider_session_id).toBeNull();
    expect(JSON.parse(rawRun.diagnostics_json)).toEqual({ copied: "[redacted] [redacted]" });
    expect(rawRun.error_text).toBe("failed [redacted] [redacted]");
    expect(JSON.parse(rawRun.transcript_tail_json)).toEqual([{ text: "[redacted] [redacted]" }]);

    const handleRun = db.prepare("SELECT provider_session_id, diagnostics_json FROM task_runs WHERE id = 'run-handle'").get();
    expect(handleRun.provider_session_id).toBe(providerSessionId);
    expect(JSON.parse(handleRun.diagnostics_json)).toEqual({ copied: "[redacted]" });
    expect(db.prepare("SELECT provider_session_id FROM task_runs WHERE id = 'run-bound'").get().provider_session_id).toBeNull();
    expect(db.prepare("SELECT provider_session_id FROM task_runs WHERE id = 'run-non-acp'").get().provider_session_id).toBe(nonAcpSession);

    expect(JSON.parse(db.prepare("SELECT events FROM agent_logs WHERE id = 'log-raw'").get().events))
      .toEqual([{ type: "message", text: "[redacted]" }]);
    expect(JSON.parse(db.prepare("SELECT events FROM agent_logs WHERE id = 'log-handle'").get().events))
      .toEqual([{ type: "message", text: "[redacted]", provider_session_id: providerSessionId }]);
    expect(JSON.parse(db.prepare("SELECT events FROM agent_logs WHERE id = 'log-unrelated-copy'").get().events))
      .toEqual([{ type: "message", text: "copied [redacted]" }]);
    expect(db.prepare("SELECT body FROM task_comments WHERE id = 'comment-acp'").get().body)
      .toBe("copied [redacted] [redacted] [redacted]");
    expect(db.prepare("SELECT body FROM task_comments WHERE id = 'comment-unrelated-copy'").get().body)
      .toBe("copied [redacted]");
    expect(db.prepare(`
      SELECT plan_body, error_text, pending_actions_json FROM tasks WHERE id = 'task-acp'
    `).get()).toEqual({
      plan_body: "promoted [redacted]",
      error_text: "promoted [redacted]",
      pending_actions_json: '[{"label":"[redacted]"}]',
    });
    expect(db.prepare("SELECT summary, metadata_json, error_text FROM run_compactions WHERE id = 'compact-acp'").get())
      .toEqual({ summary: "[redacted]", metadata_json: '{"copied":"[redacted]"}', error_text: "[redacted]" });
    expect(db.prepare("SELECT id FROM embeddings ORDER BY id").all())
      .toEqual([{ id: "embedding-unrelated" }]);
    expect(db.prepare("SELECT id FROM embeddings_fts ORDER BY id").all())
      .toEqual([{ id: "embedding-unrelated" }]);
    expect(db.prepare("SELECT id FROM agent_memories ORDER BY id").all()).toEqual([]);
    expect(db.prepare("SELECT protocol_request_id, request_schema_json, disposition FROM acp_interactions WHERE id = 'interaction-acp'").get())
      .toEqual({
        protocol_request_id: "legacy-redacted:interaction-acp",
        request_schema_json: '{"description":"[redacted]"}',
        disposition: "accepted [redacted]",
      });
    expect(db.prepare("SELECT last_probe_result_json, last_probe_error_json FROM acp_profiles WHERE id = ?").get(PROFILE_ID))
      .toEqual({
        last_probe_result_json: '{"copied":"[redacted]"}',
        last_probe_error_json: '{"message":"[redacted]"}',
      });
    expect(db.prepare(`
      SELECT remote_session_id, request_json, result_json, error_json
      FROM acp_operations WHERE id = 'operation-acp'
    `).get()).toEqual({
      remote_session_id: operationProviderSessionId,
      request_json: `{"providerSessionId":"${operationProviderSessionId}","note":"[redacted]"}`,
      result_json: '{"copied":"[redacted]"}',
      error_json: '{"message":"[redacted]"}',
    });
    expect(db.prepare("SELECT protocol_request_id, request_schema_json, disposition FROM acp_interactions WHERE id = 'interaction-operation'").get())
      .toEqual({
        protocol_request_id: "legacy-redacted:interaction-operation",
        request_schema_json: '{"description":"[redacted]"}',
        disposition: "accepted [redacted]",
      });
    expect(db.prepare("SELECT remote_session_id, request_json FROM acp_operations WHERE id = 'operation-invalid'").get())
      .toEqual({ remote_session_id: null, request_json: '{"copied":"[redacted]"}' });
    expect(db.prepare("SELECT protocol_request_id FROM acp_interactions WHERE id = 'interaction-ordinary'").get())
      .toEqual({ protocol_request_id: "ordinary-request-id" });
    expect(db.prepare("SELECT request_json, result_json FROM acp_operations WHERE id = 'operation-raw-cursor'").get())
      .toEqual({
        request_json: '{"copied":"[redacted]"}',
        result_json: '{"copied":"[redacted] [redacted]"}',
      });
    expect(db.prepare("SELECT request_json, result_json FROM acp_operations WHERE id = 'operation-opaque-cursor'").get())
      .toEqual({
        request_json: `{"cursor":"${opaqueCursor}","copied":"[redacted]"}`,
        result_json: `{"nextCursor":"${opaqueCursor}","copied":"[redacted]"}`,
      });
    expect(db.prepare("SELECT request_json, result_json FROM acp_operations WHERE id = 'operation-cursor-aliases'").get())
      .toEqual({
        request_json: '{"copied":"[redacted]"}',
        result_json: `{"next-page-cursor":"${opaqueCursor}","copied":"[redacted] [redacted]","key-[redacted]":"value"}`,
      });

    const sanitizedRaw = readFileSync(rawPath, "utf8");
    expect(sanitizedRaw).toContain(providerSessionId);
    expect(JSON.parse(sanitizedRaw.trim().split("\n")[1])).toEqual({
      type: "privacy_redaction",
      reason: "legacy_acp_session_data",
    });
    for (const sentinel of [
      rawSession,
      handleOnlySession,
      malformedLineSession,
      malformedProviderId,
      operationSession,
      invalidOperationSession,
      probeSession,
      rawCursor,
      rawNextCursor,
      rawPageCursor,
      rawPageToken,
      opaqueCursorRaw,
    ]) {
      expect(sanitizedRaw).not.toContain(sentinel);
      expect(databaseContains(dbPath, sentinel)).toBe(false);
      expect(databaseContains(`${dbPath}-wal`, sentinel)).toBe(false);
    }
    expect(db.prepare("SELECT value FROM schema_meta WHERE key = 'acp_legacy_session_privacy_compacted_v1'").get())
      .toEqual({ value: "1" });

    const stableRows = JSON.stringify({
      runs: db.prepare("SELECT * FROM task_runs ORDER BY id").all(),
      logs: db.prepare("SELECT * FROM agent_logs ORDER BY id").all(),
      comments: db.prepare("SELECT * FROM task_comments ORDER BY id").all(),
      raw: readFileSync(rawPath, "utf8"),
    });
    runMigrations(db);
    expect(JSON.stringify({
      runs: db.prepare("SELECT * FROM task_runs ORDER BY id").all(),
      logs: db.prepare("SELECT * FROM agent_logs ORDER BY id").all(),
      comments: db.prepare("SELECT * FROM task_comments ORDER BY id").all(),
      raw: readFileSync(rawPath, "utf8"),
    })).toBe(stableRows);
    db.close();
  });

  it("keeps low-entropy private values inside their owning profile and task graph", () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-acp-owned-privacy-"));
    roots.push(root);
    const dbPath = join(root, "worklab.db");
    const otherProfileId = "00000000-0000-4000-8000-000000000002";
    const probePrivateValue = "RAW_PROFILE_PROBE_COPY_493827";
    const db = openDb(dbPath);
    runMigrations(db);
    insertAcpFixture(db);
    db.prepare(`
      INSERT INTO agents (name, display_name, sdk, model, execution_mode, created_at, updated_at)
      VALUES ('external-b', 'External B', 'acp', ?, 'acp', 1, 1)
    `).run(`acp:${otherProfileId}`);
    db.prepare(`
      INSERT INTO acp_profiles (
        id, agent_name, driver, command, args_json, env_keys_json,
        configuration_owner, workspace_owner, mcp_owner,
        last_probe_result_json, created_at, updated_at
      ) VALUES (?, 'external-b', 'generic', ?, '[]', '[]', 'client', 'client', 'client', ?, 1, 1)
    `).run(
      otherProfileId,
      process.execPath,
      JSON.stringify({ status: "Java password runpin", label: "alpha" }),
    );
    db.prepare(`
      UPDATE acp_profiles SET last_probe_result_json = ? WHERE id = ?
    `).run(
      JSON.stringify({
        sessionId: probePrivateValue,
        copied: `Java password runpin ${probePrivateValue}`,
      }),
      PROFILE_ID,
    );
    db.prepare(`
      INSERT INTO tasks (
        id, title, plan_body, pending_actions_json, created_at, updated_at
      ) VALUES ('task-b', 'Task B', 'Java password runpin', ?, 1, 1)
    `).run(JSON.stringify([{ label: "alpha", value: "Java password runpin" }]));
    db.prepare(`
      UPDATE tasks SET plan_body = 'Java password runpin', pending_actions_json = ?
      WHERE id = 'task-acp'
    `).run(JSON.stringify([{ label: "alpha", value: "Java password runpin" }]));
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status,
        process_status, started_at, diagnostics_json
      ) VALUES ('run-a-owned', 'task-acp', 'execute', 'execute', 'external',
        'acp', 'complete', 'succeeded', 1, ?)
    `).run(JSON.stringify({ pageToken: "a", nextToken: "runpin", copied: "Java password" }));
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status,
        process_status, started_at, diagnostics_json
      ) VALUES ('run-b-owned', 'task-b', 'execute', 'execute', 'external-b',
        'acp', 'complete', 'succeeded', 2, ?)
    `).run(JSON.stringify({ status: "Java password runpin", label: "alpha" }));
    db.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json, error_json,
        created_at, updated_at, completed_at
      ) VALUES ('operation-a-owned', ?, 'list_sessions', 'succeeded', '{}', ?, '{}', 1, 1, 1)
    `).run(
      PROFILE_ID,
      JSON.stringify({
        nextToken: "password",
        copied: `Java password runpin ${probePrivateValue}`,
      }),
    );
    db.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json, error_json,
        created_at, updated_at, completed_at
      ) VALUES ('operation-b-owned', ?, 'probe', 'succeeded', ?, ?, '{}', 2, 2, 2)
    `).run(
      otherProfileId,
      JSON.stringify({ label: "alpha" }),
      JSON.stringify({ status: "Java password runpin", label: "alpha" }),
    );
    db.prepare(`
      INSERT INTO acp_interactions (
        id, profile_id, operation_id, protocol_request_id, kind,
        request_schema_json, state, disposition, created_at, updated_at
      ) VALUES ('interaction-a-owned', ?, 'operation-a-owned', 'request-a',
        'form', ?, 'submitted', 'accept', 1, 1)
    `).run(
      PROFILE_ID,
      JSON.stringify({ description: `Java password ${probePrivateValue}` }),
    );
    db.prepare(`
      INSERT INTO acp_interactions (
        id, profile_id, operation_id, protocol_request_id, kind,
        request_schema_json, state, disposition, created_at, updated_at
      ) VALUES ('interaction-b-owned', ?, 'operation-b-owned', 'request-b',
        'form', ?, 'submitted', 'accept', 2, 2)
    `).run(
      otherProfileId,
      JSON.stringify({ description: "Java password runpin", label: "alpha" }),
    );
    db.prepare("DELETE FROM schema_meta WHERE key = 'acp_legacy_session_privacy_compacted_v1'").run();
    db.prepare("UPDATE schema_meta SET value = '48' WHERE key = 'version'").run();

    runMigrations(db);

    const taskA = db.prepare("SELECT plan_body, pending_actions_json FROM tasks WHERE id = 'task-acp'").get();
    expect(taskA.plan_body).not.toContain("password");
    expect(taskA.plan_body).not.toContain("Java");
    expect(taskA.pending_actions_json).not.toContain("password");
    expect(db.prepare("SELECT plan_body, pending_actions_json FROM tasks WHERE id = 'task-b'").get())
      .toEqual({
        plan_body: "Java password runpin",
        pending_actions_json: '[{"label":"alpha","value":"Java password runpin"}]',
      });
    expect(db.prepare(`
      SELECT last_probe_result_json FROM acp_profiles WHERE id = ?
    `).get(otherProfileId).last_probe_result_json)
      .toBe('{"status":"Java password runpin","label":"alpha"}');
    expect(db.prepare(`
      SELECT request_json, result_json FROM acp_operations WHERE id = 'operation-b-owned'
    `).get()).toEqual({
      request_json: '{"label":"alpha"}',
      result_json: '{"status":"Java password runpin","label":"alpha"}',
    });
    expect(db.prepare(`
      SELECT request_schema_json FROM acp_interactions WHERE id = 'interaction-b-owned'
    `).get().request_schema_json)
      .toBe('{"description":"Java password runpin","label":"alpha"}');
    expect(db.prepare(`
      SELECT last_probe_result_json FROM acp_profiles WHERE id = ?
    `).get(PROFILE_ID).last_probe_result_json).not.toContain(probePrivateValue);
    expect(db.prepare(`
      SELECT last_probe_result_json FROM acp_profiles WHERE id = ?
    `).get(PROFILE_ID).last_probe_result_json).not.toContain("runpin");
    expect(db.prepare(`
      SELECT request_schema_json FROM acp_interactions WHERE id = 'interaction-a-owned'
    `).get().request_schema_json).not.toContain(probePrivateValue);
    expect(databaseContains(dbPath, probePrivateValue)).toBe(false);
    expect(databaseContains(`${dbPath}-wal`, probePrivateValue)).toBe(false);
    db.close();
  });

  it("detaches an ACP raw log outside the database data directory without mutating it", () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-acp-path-"));
    roots.push(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "worklab.db");
    const outsidePath = join(root, "outside.jsonl");
    const outsideContent = '{"sessionId":"DO_NOT_TOUCH_OUTSIDE"}\n';
    writeFileSync(outsidePath, outsideContent);
    const db = openDb(dbPath);
    runMigrations(db);
    insertAcpFixture(db);
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status,
        process_status, started_at, raw_output_path
      ) VALUES ('run-outside', 'task-acp', 'execute', 'execute', 'external',
        'acp', 'complete', 'succeeded', 1, ?)
    `).run(outsidePath);

    runMigrations(db);

    expect(db.prepare("SELECT raw_output_path FROM task_runs WHERE id = 'run-outside'").get().raw_output_path).toBeNull();
    expect(readFileSync(outsidePath, "utf8")).toBe(outsideContent);
    db.close();
  });
});
