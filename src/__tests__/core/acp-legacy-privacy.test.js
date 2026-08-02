import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
    const nonAcpSession = "NON_ACP_SESSION_MUST_SURVIVE";
    const providerSessionId = opaqueSessionId(handleOnlySession);
    writeFileSync(rawPath, [
      JSON.stringify({
        type: "sdk_event",
        sessionId: rawSession,
        providerSessionId,
        message: `${rawSession} ${handleOnlySession}`,
      }),
      `{"type":"partial","sessionId":"${malformedLineSession}"`,
      "",
    ].join("\n"), { mode: 0o600 });

    const db = openDb(dbPath);
    runMigrations(db);
    insertAcpFixture(db);
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
      INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
      VALUES ('log-raw', 'run-raw', ?, 'complete', 1)
    `).run(JSON.stringify([{ type: "message", text: rawSession, session_id: rawSession }]));
    db.prepare(`
      INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
      VALUES ('log-handle', 'run-handle', ?, 'complete', 2)
    `).run(JSON.stringify([{ type: "message", text: handleOnlySession, provider_session_id: providerSessionId }]));
    db.prepare(`
      INSERT INTO task_comments (id, task_id, author_type, body, created_at)
      VALUES ('comment-acp', 'task-acp', 'system', ?, 1)
    `).run(`copied ${rawSession} ${handleOnlySession} ${malformedLineSession}`);
    db.prepare(`
      INSERT INTO run_compactions (
        id, task_run_id, seq, trigger, summary, metadata_json, error_text, created_at
      ) VALUES ('compact-acp', 'run-raw', 1, 'manual', ?, ?, ?, 1)
    `).run(rawSession, JSON.stringify({ sessionId: rawSession, copied: rawSession }), malformedProviderId);
    db.prepare(`
      INSERT INTO acp_interactions (
        id, profile_id, task_run_id, protocol_request_id, kind,
        request_schema_json, state, disposition, created_at, updated_at
      ) VALUES ('interaction-acp', ?, 'run-raw', 'request-1', 'form', ?, 'submitted', ?, 1, 1)
    `).run(PROFILE_ID, JSON.stringify({ session_id: rawSession, description: rawSession }), `accepted ${rawSession}`);

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
    expect(db.prepare("SELECT body FROM task_comments WHERE id = 'comment-acp'").get().body)
      .toBe("copied [redacted] [redacted] [redacted]");
    expect(db.prepare("SELECT summary, metadata_json, error_text FROM run_compactions WHERE id = 'compact-acp'").get())
      .toEqual({ summary: "[redacted]", metadata_json: '{"copied":"[redacted]"}', error_text: "[redacted]" });
    expect(db.prepare("SELECT request_schema_json, disposition FROM acp_interactions WHERE id = 'interaction-acp'").get())
      .toEqual({ request_schema_json: '{"description":"[redacted]"}', disposition: "accepted [redacted]" });

    const sanitizedRaw = readFileSync(rawPath, "utf8");
    expect(sanitizedRaw).toContain(providerSessionId);
    expect(JSON.parse(sanitizedRaw.trim().split("\n")[1])).toEqual({
      type: "privacy_redaction",
      reason: "legacy_acp_session_data",
    });
    for (const sentinel of [rawSession, handleOnlySession, malformedLineSession, malformedProviderId]) {
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
