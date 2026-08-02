import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "../../cli/backup.js";
import { launchdPlist, serviceParams, systemdUnit } from "../../cli/install-service.js";
import { createAcpProfile } from "../../core/acp-profiles.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import { SCHEMA_VERSION } from "../../core/db/schema/current.js";
import { ACP_URL_PUBLIC_REQUEST } from "../../core/acp-url-handoff.js";
import { createAcpOperationManager } from "../../coordinator/acp-operation-manager.js";

function opaqueV2Token(prefix, profileId, raw) {
  const sealed = Buffer.concat([
    Buffer.alloc(12, 0x6e),
    Buffer.from(raw),
    Buffer.alloc(16, 0x74),
  ]).toString("base64url");
  return `${prefix}${profileId}:${sealed}`;
}

describe("backup command", () => {
  const dirs = [];
  const oldDataDir = process.env.WORKLAB_DATA_DIR;
  const oldBackupToken = process.env.ACP_BACKUP_TOKEN;

  afterEach(() => {
    if (oldDataDir === undefined) delete process.env.WORKLAB_DATA_DIR;
    else process.env.WORKLAB_DATA_DIR = oldDataDir;
    if (oldBackupToken === undefined) delete process.env.ACP_BACKUP_TOKEN;
    else process.env.ACP_BACKUP_TOKEN = oldBackupToken;
    vi.restoreAllMocks();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmp(name) {
    const dir = join(tmpdir(), `worklab-${name}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  it("creates a private archive without credential stores or runtime logs", async () => {
    const dataDir = tmp("backup-data");
    const outDir = tmp("backup-out");
    mkdirSync(join(dataDir, "knowledge"), { recursive: true });
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(join(dataDir, "knowledge", "note.md"), "hello");
    writeFileSync(join(dataDir, "config", "layout.json"), "non-secret-config");
    writeFileSync(join(dataDir, "logs", "worklab.out.log"), "runtime");
    writeFileSync(join(dataDir, ".coordinator.pid"), "12345");
    writeFileSync(join(dataDir, ".coordinator.lock"), "runtime-lock");
    const secretFiles = new Map([
      [".env", "backup-env-file-secret"],
      [".provider-encryption-key", "backup-provider-key-secret"],
      ["auth.json", "backup-legacy-auth-secret"],
      ["mcp-token", "backup-mcp-token-secret"],
      ["pi-auth.json", "backup-pi-auth-secret"],
      ["push-vapid.json", "backup-vapid-secret"],
      ["config/mcp.json", "backup-mcp-config-secret"],
    ]);
    for (const [path, secret] of secretFiles) writeFileSync(join(dataDir, path), secret);
    process.env.WORKLAB_DATA_DIR = dataDir;

    const lines = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    await backup(["--out", outDir]);

    const archive = lines.find((line) => line.startsWith("backup: ")).replace("backup: ", "");
    expect(existsSync(archive)).toBe(true);
    const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    const contents = execFileSync("tar", ["-xOzf", archive], { encoding: "utf8" });
    expect(listing).toContain("./knowledge/note.md");
    expect(listing).toContain("./config/layout.json");
    expect(contents).toContain("non-secret-config");
    expect(listing).not.toContain("logs/worklab.out.log");
    expect(listing).not.toContain(".coordinator.pid");
    expect(listing).not.toContain(".coordinator.lock");
    for (const [path, secret] of secretFiles) {
      expect(listing).not.toContain(path);
      expect(contents).not.toContain(secret);
    }
    expect(statSync(outDir).mode & 0o777).toBe(0o700);
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    expect(lines.find((line) => line.startsWith("restore: "))).toContain(dataDir);
  });

  it("rejects backup output anywhere inside the active data directory", async () => {
    const dataDir = tmp("backup-nested-output-data");
    mkdirSync(join(dataDir, "knowledge"), { recursive: true });
    writeFileSync(join(dataDir, "knowledge", "note.md"), "must remain eligible for backup");
    process.env.WORKLAB_DATA_DIR = dataDir;

    const nestedOut = join(dataDir, "knowledge", "backups");
    await expect(backup(["--out", nestedOut])).rejects.toThrow(/outside the Worklab data directory/);
    expect(existsSync(nestedOut)).toBe(false);
    expect(readFileSync(join(dataDir, "knowledge", "note.md"), "utf8"))
      .toBe("must remain eligible for backup");
  });

  it("scrubs legacy cursors and invalidates v2 cursor envelopes omitted from the backup key", async () => {
    const dataDir = tmp("backup-acp-cursor-data");
    const outDir = tmp("backup-acp-cursor-out");
    const restoredDir = tmp("backup-acp-cursor-restored");
    const workspace = tmp("backup-acp-cursor-workspace");
    process.env.WORKLAB_DATA_DIR = dataDir;

    const sourceDb = openDb(join(dataDir, "worklab.db"));
    runMigrations(sourceDb);
    const profile = createAcpProfile({
      db: sourceDb,
      input: {
        agentName: "backup-acp-cursor",
        displayName: "Backup ACP cursor",
        command: process.execPath,
        cwd: workspace,
      },
    });
    const malformedProfile = createAcpProfile({
      db: sourceDb,
      input: {
        agentName: "backup-acp-malformed-cursor",
        displayName: "Backup ACP malformed cursor",
        command: process.execPath,
        cwd: workspace,
      },
    });
    const canonicalRawCursor = "backup-canonical-raw-cursor-secret";
    const canonicalCursor = opaqueV2Token("acp-cursor:v2:", profile.id, canonicalRawCursor);
    const legacyRawCursor = "backup-legacy-raw-cursor-secret-493827";
    const malformedRawCursor = "backup-malformed-raw-cursor-secret";
    const malformedCursor = `acp-cursor:v1:another-profile:${Buffer.from(malformedRawCursor).toString("base64url")}`;
    const nestedMalformedCursor = "pin42";
    const aliasRawPageCursor = "backup-page-cursor-alias-secret-493827";
    const aliasCanonicalRawCursor = "backup-next-page-cursor-alias-secret";
    const aliasCanonicalCursor = `acp-cursor:v1:${profile.id}:${Buffer.from(aliasCanonicalRawCursor).toString("base64url")}`;
    const aliasRawPageToken = "backup-page-token-alias-secret-493827";
    const oversizedPageToken = `backup-oversized-page-token-${"x".repeat(4_096)}`;
    const now = Date.now();
    const insertOperation = sourceDb.prepare(`
      INSERT INTO acp_operations
        (id, profile_id, kind, state, request_json, result_json, error_json,
         created_at, updated_at, started_at, completed_at)
      VALUES (?, ?, 'list_sessions', 'succeeded', ?, ?, '{}', ?, ?, ?, ?)
    `);
    insertOperation.run(
      "acpop-backup-canonical-cursor",
      profile.id,
      JSON.stringify({ cursor: canonicalCursor, copied: "canonical-request-copy", keep: "canonical-request" }),
      JSON.stringify({ sessions: [], nextCursor: canonicalCursor, copied: "canonical-result-copy" }),
      now,
      now,
      now,
      now,
    );
    insertOperation.run(
      "acpop-backup-legacy-cursor",
      profile.id,
      JSON.stringify({ cursor: legacyRawCursor, keep: "legacy-request" }),
      JSON.stringify({ sessions: [], next_cursor: legacyRawCursor, copied: legacyRawCursor }),
      now,
      now,
      now,
      now,
    );
    insertOperation.run(
      "acpop-backup-malformed-cursor",
      malformedProfile.id,
      JSON.stringify({ cursor: malformedCursor, copied: malformedRawCursor }),
      JSON.stringify({ sessions: [], nextCursor: { opaque: nestedMalformedCursor } }),
      now,
      now,
      now,
      now,
    );
    insertOperation.run(
      "acpop-backup-cursor-aliases",
      profile.id,
      JSON.stringify({
        pageCursor: aliasRawPageCursor,
        copied: aliasRawPageCursor,
      }),
      JSON.stringify({
        sessions: [],
        "next-page-cursor": aliasCanonicalCursor,
        pageToken: aliasRawPageToken,
        copied: `${aliasCanonicalRawCursor} ${aliasRawPageToken}`,
        [`key-${aliasRawPageToken}`]: "value",
      }),
      now,
      now,
      now,
      now,
    );
    insertOperation.run(
      "acpop-backup-oversized-cursor-alias",
      profile.id,
      "{}",
      JSON.stringify({ sessions: [], pageToken: oversizedPageToken }),
      now,
      now,
      now,
      now,
    );
    sourceDb.prepare(`
      INSERT INTO tasks (id, task_key, title, instructions, created_at, updated_at)
      VALUES ('task-backup-cursors', 'T-CURSORS', 'Cursor backup', '', ?, ?)
    `).run(now, now);
    sourceDb.prepare(`
      INSERT INTO tasks (id, task_key, title, plan_body, created_at, updated_at)
      VALUES ('task-backup-malformed-cursor', 'T-MALFORMED-CURSOR',
        'Malformed cursor backup', ?, ?, ?)
    `).run(`Copied ${nestedMalformedCursor}`, now, now);
    sourceDb.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status,
        process_status, started_at, diagnostics_json
      ) VALUES ('run-backup-malformed-cursor', 'task-backup-malformed-cursor',
        'execute', 'execute', 'backup-acp-malformed-cursor', 'acp', 'complete',
        'succeeded', ?, '{}')
    `).run(now);
    sourceDb.prepare(`
      INSERT INTO task_comments (id, task_id, author_type, body, created_at)
      VALUES ('comment-backup-cursors', 'task-backup-cursors', 'system', ?, ?)
    `).run(
      `Copied ${legacyRawCursor}, ${aliasRawPageCursor}, ${aliasCanonicalRawCursor}, and ${aliasRawPageToken}`,
      now,
    );
    sourceDb.close();

    const lines = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    await backup(["--out", outDir]);
    const archive = lines.find((line) => line.startsWith("backup: ")).replace("backup: ", "");
    execFileSync("tar", ["-xzf", archive, "-C", restoredDir]);

    const restoredDbPath = join(restoredDir, "worklab.db");
    const restoredDb = openDb(restoredDbPath);
    try {
      const canonical = restoredDb.prepare(`
        SELECT request_json, result_json FROM acp_operations WHERE id = 'acpop-backup-canonical-cursor'
      `).get();
      expect(JSON.parse(canonical.request_json)).toEqual({
        copied: "canonical-request-copy",
        keep: "canonical-request",
      });
      expect(JSON.parse(canonical.result_json)).toEqual({
        sessions: [],
        copied: "canonical-result-copy",
      });

      const legacy = restoredDb.prepare(`
        SELECT request_json, result_json FROM acp_operations WHERE id = 'acpop-backup-legacy-cursor'
      `).get();
      expect(JSON.parse(legacy.request_json)).toEqual({ keep: "legacy-request" });
      expect(JSON.parse(legacy.result_json)).toEqual({ sessions: [], copied: "[redacted]" });

      const malformed = restoredDb.prepare(`
        SELECT request_json, result_json FROM acp_operations WHERE id = 'acpop-backup-malformed-cursor'
      `).get();
      expect(JSON.parse(malformed.request_json)).toEqual({
        redacted: true,
        reason: "ACP session data exceeded backup scrub limits",
      });
      expect(JSON.parse(malformed.result_json)).toEqual({
        redacted: true,
        reason: "ACP session data exceeded backup scrub limits",
      });
      expect(restoredDb.prepare(`
        SELECT plan_body FROM tasks WHERE id = 'task-backup-malformed-cursor'
      `).get().plan_body).toBe("[redacted]");

      const aliases = restoredDb.prepare(`
        SELECT request_json, result_json FROM acp_operations WHERE id = 'acpop-backup-cursor-aliases'
      `).get();
      expect(JSON.parse(aliases.request_json)).toEqual({ copied: "[redacted]" });
      expect(JSON.parse(aliases.result_json)).toEqual({
        sessions: [],
        copied: "[redacted] [redacted]",
        "key-[redacted]": "value",
      });

      const oversized = restoredDb.prepare(`
        SELECT result_json FROM acp_operations WHERE id = 'acpop-backup-oversized-cursor-alias'
      `).get();
      expect(JSON.parse(oversized.result_json)).toEqual({
        redacted: true,
        reason: "ACP pagination cursor data was invalid",
      });
      expect(restoredDb.prepare(`
        SELECT body FROM task_comments WHERE id = 'comment-backup-cursors'
      `).get().body).toBe("Copied [redacted], [redacted], [redacted], and [redacted]");
    } finally {
      restoredDb.close();
    }

    const restoredBytes = readFileSync(restoredDbPath);
    expect(restoredBytes.includes(Buffer.from(canonicalCursor))).toBe(false);
    for (const privateValue of [
      canonicalRawCursor,
      legacyRawCursor,
      malformedRawCursor,
      malformedCursor,
      nestedMalformedCursor,
      aliasRawPageCursor,
      aliasCanonicalRawCursor,
      aliasRawPageToken,
      oversizedPageToken,
    ]) {
      expect(restoredBytes.includes(Buffer.from(privateValue))).toBe(false);
    }
  });

  it("replaces malformed ACP JSON fields before writing the archive", async () => {
    const dataDir = tmp("backup-acp-malformed-data");
    const outDir = tmp("backup-acp-malformed-out");
    const restoredDir = tmp("backup-acp-malformed-restored");
    const workspace = tmp("backup-acp-malformed-workspace");
    process.env.WORKLAB_DATA_DIR = dataDir;
    const sourceDb = openDb(join(dataDir, "worklab.db"));
    runMigrations(sourceDb);
    const profile = createAcpProfile({
      db: sourceDb,
      input: {
        agentName: "backup-acp-malformed",
        displayName: "Backup ACP malformed",
        command: process.execPath,
        cwd: workspace,
      },
    });
    const secrets = {
      profileResult: "MALFORMED_PROFILE_RESULT_SECRET_493827",
      profileError: "MALFORMED_PROFILE_ERROR_SECRET_493827",
      operation: "MALFORMED_OPERATION_ERROR_SECRET_493827",
      interaction: "MALFORMED_INTERACTION_SECRET_493827",
      run: "MALFORMED_RUN_JSON_SECRET_493827",
      log: "MALFORMED_LOG_JSON_SECRET_493827",
    };
    sourceDb.prepare(`
      UPDATE acp_profiles SET last_probe_result_json = ?, last_probe_error_json = ? WHERE id = ?
    `).run(
      `{"sessionId":"${secrets.profileResult}"`,
      `{"sessionId":"${secrets.profileError}"`,
      profile.id,
    );
    sourceDb.prepare(`
      INSERT INTO tasks (id, title, created_at, updated_at)
      VALUES ('task-backup-malformed', 'Malformed backup', 1, 1)
    `).run();
    sourceDb.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status,
        process_status, started_at, diagnostics_json
      ) VALUES ('run-backup-malformed', 'task-backup-malformed', 'execute', 'execute',
        'backup-acp-malformed', 'acp', 'complete', 'succeeded', 1, ?)
    `).run(`{"sessionId":"${secrets.run}"`);
    sourceDb.prepare(`
      INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
      VALUES ('log-backup-malformed', 'run-backup-malformed', ?, 'complete', 1)
    `).run(`[{"sessionId":"${secrets.log}"`);
    sourceDb.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json, error_json,
        created_at, updated_at, completed_at
      ) VALUES ('operation-backup-malformed', ?, 'probe', 'failed', '{}', '{}', ?, 1, 1, 1)
    `).run(profile.id, `{"sessionId":"${secrets.operation}"`);
    sourceDb.prepare(`
      INSERT INTO acp_interactions (
        id, profile_id, operation_id, protocol_request_id, kind,
        request_schema_json, state, created_at, updated_at
      ) VALUES ('interaction-backup-malformed', ?, 'operation-backup-malformed',
        'request-malformed', 'form', ?, 'pending', 1, 1)
    `).run(profile.id, `{"sessionId":"${secrets.interaction}"`);
    sourceDb.close();

    const lines = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    await backup(["--out", outDir]);
    const archive = lines.find((line) => line.startsWith("backup: ")).replace("backup: ", "");
    execFileSync("tar", ["-xzf", archive, "-C", restoredDir]);
    const restoredDbPath = join(restoredDir, "worklab.db");
    const restoredDb = openDb(restoredDbPath);
    const fallback = {
      redacted: true,
      reason: "ACP session data exceeded backup scrub limits",
    };
    try {
      const restoredProfile = restoredDb.prepare(`
        SELECT last_probe_result_json, last_probe_error_json FROM acp_profiles WHERE id = ?
      `).get(profile.id);
      expect(JSON.parse(restoredProfile.last_probe_result_json)).toEqual(fallback);
      expect(JSON.parse(restoredProfile.last_probe_error_json)).toEqual(fallback);
      expect(JSON.parse(restoredDb.prepare(`
        SELECT error_json FROM acp_operations WHERE id = 'operation-backup-malformed'
      `).get().error_json)).toEqual(fallback);
      expect(JSON.parse(restoredDb.prepare(`
        SELECT request_schema_json FROM acp_interactions WHERE id = 'interaction-backup-malformed'
      `).get().request_schema_json)).toEqual(fallback);
      expect(JSON.parse(restoredDb.prepare(`
        SELECT diagnostics_json FROM task_runs WHERE id = 'run-backup-malformed'
      `).get().diagnostics_json)).toEqual(fallback);
      expect(JSON.parse(restoredDb.prepare(`
        SELECT events FROM agent_logs WHERE id = 'log-backup-malformed'
      `).get().events)).toEqual(fallback);
    } finally {
      restoredDb.close();
    }
    const restoredBytes = readFileSync(restoredDbPath);
    for (const secret of Object.values(secrets)) {
      expect(restoredBytes.includes(Buffer.from(secret))).toBe(false);
    }
  });

  it("fails closed across an owning ACP graph when identifier collection is incomplete", async () => {
    const dataDir = tmp("backup-acp-incomplete-data");
    const outDir = tmp("backup-acp-incomplete-out");
    const restoredDir = tmp("backup-acp-incomplete-restored");
    const workspace = tmp("backup-acp-incomplete-workspace");
    process.env.WORKLAB_DATA_DIR = dataDir;
    const sourceDb = openDb(join(dataDir, "worklab.db"));
    runMigrations(sourceDb);
    const profileA = createAcpProfile({
      db: sourceDb,
      input: {
        agentName: "backup-incomplete-a",
        displayName: "Backup incomplete A",
        command: process.execPath,
        cwd: workspace,
      },
    });
    const profileB = createAcpProfile({
      db: sourceDb,
      input: {
        agentName: "backup-incomplete-b",
        displayName: "Backup incomplete B",
        command: process.execPath,
        cwd: workspace,
      },
    });
    const malformedSecret = "BACKUP_MALFORMED_GRAPH_SECRET_493827";
    const deepSecret = "BACKUP_DEEP_GRAPH_SECRET_493827";
    let deepSource = { sessions: [{ id: deepSecret }] };
    for (let depth = 0; depth < 40; depth += 1) deepSource = { nested: deepSource };
    for (const [id, title, plan] of [
      ["task-backup-incomplete-a", "Incomplete A", `${malformedSecret} ${deepSecret}`],
      ["task-backup-incomplete-b", "Incomplete B", "Unrelated profile survives"],
    ]) {
      sourceDb.prepare(`
        INSERT INTO tasks (id, title, plan_body, pending_actions_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 1)
      `).run(id, title, plan, JSON.stringify([{ label: plan }]));
    }
    for (const [id, taskId, agentName] of [
      ["run-backup-incomplete-a", "task-backup-incomplete-a", "backup-incomplete-a"],
      ["run-backup-incomplete-b", "task-backup-incomplete-b", "backup-incomplete-b"],
    ]) {
      sourceDb.prepare(`
        INSERT INTO task_runs (
          id, task_id, mode, stage, agent_name, provider_kind, status,
          process_status, started_at, diagnostics_json
        ) VALUES (?, ?, 'execute', 'execute', ?, 'acp', 'complete', 'succeeded', 1, ?)
      `).run(id, taskId, agentName, JSON.stringify({ status: "ordinary" }));
    }
    sourceDb.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json, error_json,
        created_at, updated_at, completed_at
      ) VALUES ('operation-backup-incomplete-a', ?, 'probe', 'failed', ?, ?, '{}', 1, 1, 1)
    `).run(
      profileA.id,
      `{"opaque":"${malformedSecret}"`,
      JSON.stringify(deepSource),
    );
    sourceDb.prepare(`
      INSERT INTO task_comments (id, task_id, author_type, body, created_at)
      VALUES ('comment-backup-incomplete-a', 'task-backup-incomplete-a', 'system', ?, 1)
    `).run(`Copied ${malformedSecret} ${deepSecret}`);
    sourceDb.prepare(`
      INSERT INTO run_compactions (
        id, task_run_id, seq, trigger, summary, metadata_json, error_text, created_at
      ) VALUES ('compaction-backup-incomplete-a', 'run-backup-incomplete-a', 1,
        'manual', ?, ?, ?, 1)
    `).run(
      `Summary ${malformedSecret}`,
      JSON.stringify({ copied: deepSecret }),
      `Error ${deepSecret}`,
    );
    sourceDb.prepare(`
      UPDATE acp_profiles SET last_probe_result_json = ? WHERE id = ?
    `).run(JSON.stringify({ status: "Unrelated profile survives" }), profileB.id);
    sourceDb.close();

    const lines = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    await backup(["--out", outDir]);
    const archive = lines.find((line) => line.startsWith("backup: ")).replace("backup: ", "");
    execFileSync("tar", ["-xzf", archive, "-C", restoredDir]);
    const restoredDbPath = join(restoredDir, "worklab.db");
    const restoredDb = openDb(restoredDbPath);
    const fallback = JSON.stringify({
      redacted: true,
      reason: "ACP session data exceeded backup scrub limits",
    });
    try {
      expect(restoredDb.prepare(`
        SELECT request_json, result_json, error_json
        FROM acp_operations WHERE id = 'operation-backup-incomplete-a'
      `).get()).toEqual({ request_json: fallback, result_json: fallback, error_json: fallback });
      expect(restoredDb.prepare(`
        SELECT plan_body, pending_actions_json
        FROM tasks WHERE id = 'task-backup-incomplete-a'
      `).get()).toEqual({ plan_body: "[redacted]", pending_actions_json: fallback });
      expect(restoredDb.prepare(`
        SELECT body FROM task_comments WHERE id = 'comment-backup-incomplete-a'
      `).get().body).toBe("[redacted]");
      expect(restoredDb.prepare(`
        SELECT summary, metadata_json, error_text
        FROM run_compactions WHERE id = 'compaction-backup-incomplete-a'
      `).get()).toEqual({ summary: "[redacted]", metadata_json: fallback, error_text: "[redacted]" });
      expect(restoredDb.prepare(`
        SELECT plan_body, pending_actions_json
        FROM tasks WHERE id = 'task-backup-incomplete-b'
      `).get()).toEqual({
        plan_body: "Unrelated profile survives",
        pending_actions_json: '[{"label":"Unrelated profile survives"}]',
      });
      expect(restoredDb.prepare(`
        SELECT last_probe_result_json FROM acp_profiles WHERE id = ?
      `).get(profileB.id).last_probe_result_json)
        .toBe('{"status":"Unrelated profile survives"}');
    } finally {
      restoredDb.close();
    }
    const restoredBytes = readFileSync(restoredDbPath);
    expect(restoredBytes.includes(Buffer.from(malformedSecret))).toBe(false);
    expect(restoredBytes.includes(Buffer.from(deepSecret))).toBe(false);
  });

  it("keeps low-entropy ACP values inside their owning backup graph", async () => {
    const dataDir = tmp("backup-acp-owned-data");
    const outDir = tmp("backup-acp-owned-out");
    const restoredDir = tmp("backup-acp-owned-restored");
    const workspace = tmp("backup-acp-owned-workspace");
    process.env.WORKLAB_DATA_DIR = dataDir;
    const sourceDb = openDb(join(dataDir, "worklab.db"));
    runMigrations(sourceDb);
    const profileA = createAcpProfile({
      db: sourceDb,
      input: {
        agentName: "backup-owned-a",
        displayName: "Backup owned A",
        command: process.execPath,
        cwd: workspace,
      },
    });
    const profileB = createAcpProfile({
      db: sourceDb,
      input: {
        agentName: "backup-owned-b",
        displayName: "Backup owned B",
        command: process.execPath,
        cwd: workspace,
      },
    });
    sourceDb.prepare(`
      UPDATE acp_profiles SET last_probe_result_json = ? WHERE id = ?
    `).run(JSON.stringify({ copied: "runpin" }), profileA.id);
    sourceDb.prepare(`
      UPDATE acp_profiles SET last_probe_result_json = ? WHERE id = ?
    `).run(JSON.stringify({ status: "Java password runpin", label: "alpha" }), profileB.id);
    for (const [id, title, plan] of [
      ["task-backup-owned-a", "Owned A", "Java password runpin"],
      ["task-backup-owned-b", "Owned B", "Java password runpin"],
      ["task-backup-unrelated", "Unrelated", "Java password runpin"],
    ]) {
      sourceDb.prepare(`
        INSERT INTO tasks (id, title, plan_body, pending_actions_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 1)
      `).run(id, title, plan, JSON.stringify([{ label: "alpha", value: plan }]));
    }
    sourceDb.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status,
        process_status, started_at, diagnostics_json
      ) VALUES ('run-backup-owned-a', 'task-backup-owned-a', 'execute', 'execute',
        'backup-owned-a', 'acp', 'complete', 'succeeded', 1, ?)
    `).run(JSON.stringify({ pageToken: "a", nextToken: "runpin", copied: "Java password" }));
    sourceDb.prepare(`
      INSERT INTO task_runs (
        id, task_id, mode, stage, agent_name, provider_kind, status,
        process_status, started_at, diagnostics_json
      ) VALUES ('run-backup-owned-b', 'task-backup-owned-b', 'execute', 'execute',
        'backup-owned-b', 'acp', 'complete', 'succeeded', 2, ?)
    `).run(JSON.stringify({ status: "Java password runpin", label: "alpha" }));
    sourceDb.prepare(`
      INSERT INTO task_comments (id, task_id, author_type, body, created_at)
      VALUES ('comment-backup-unrelated', 'task-backup-unrelated', 'system', 'Java password', 1)
    `).run();
    sourceDb.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json, error_json,
        created_at, updated_at, completed_at
      ) VALUES ('operation-backup-owned-a', ?, 'list_sessions', 'succeeded', '{}', ?, '{}', 1, 1, 1)
    `).run(
      profileA.id,
      JSON.stringify({ nextToken: "password", copied: "Java password runpin" }),
    );
    sourceDb.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, request_json, result_json, error_json,
        created_at, updated_at, completed_at
      ) VALUES ('operation-backup-owned-b', ?, 'probe', 'succeeded', ?, ?, '{}', 2, 2, 2)
    `).run(
      profileB.id,
      JSON.stringify({ label: "alpha" }),
      JSON.stringify({ status: "Java password runpin", label: "alpha" }),
    );
    sourceDb.prepare(`
      INSERT INTO acp_interactions (
        id, profile_id, operation_id, protocol_request_id, kind,
        request_schema_json, state, created_at, updated_at
      ) VALUES ('interaction-backup-owned-b', ?, 'operation-backup-owned-b',
        'request-b', 'form', ?, 'pending', 2, 2)
    `).run(
      profileB.id,
      JSON.stringify({ description: "Java password runpin", label: "alpha" }),
    );
    sourceDb.close();

    const lines = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    await backup(["--out", outDir]);
    const archive = lines.find((line) => line.startsWith("backup: ")).replace("backup: ", "");
    execFileSync("tar", ["-xzf", archive, "-C", restoredDir]);
    const restoredDb = openDb(join(restoredDir, "worklab.db"));
    try {
      const taskA = restoredDb.prepare(`
        SELECT plan_body, pending_actions_json FROM tasks WHERE id = 'task-backup-owned-a'
      `).get();
      expect(taskA.plan_body).not.toContain("Java");
      expect(taskA.plan_body).not.toContain("password");
      expect(restoredDb.prepare(`
        SELECT plan_body, pending_actions_json FROM tasks WHERE id = 'task-backup-owned-b'
      `).get()).toEqual({
        plan_body: "Java password runpin",
        pending_actions_json: '[{"label":"alpha","value":"Java password runpin"}]',
      });
      expect(restoredDb.prepare(`
        SELECT plan_body FROM tasks WHERE id = 'task-backup-unrelated'
      `).get().plan_body).toBe("Java password runpin");
      expect(restoredDb.prepare(`
        SELECT body FROM task_comments WHERE id = 'comment-backup-unrelated'
      `).get().body).toBe("Java password");
      expect(restoredDb.prepare(`
        SELECT last_probe_result_json FROM acp_profiles WHERE id = ?
      `).get(profileA.id).last_probe_result_json).not.toContain("runpin");
      expect(restoredDb.prepare(`
        SELECT last_probe_result_json FROM acp_profiles WHERE id = ?
      `).get(profileB.id).last_probe_result_json)
        .toBe('{"status":"Java password runpin","label":"alpha"}');
      expect(restoredDb.prepare(`
        SELECT request_json, result_json FROM acp_operations WHERE id = 'operation-backup-owned-b'
      `).get()).toEqual({
        request_json: '{"label":"alpha"}',
        result_json: '{"status":"Java password runpin","label":"alpha"}',
      });
      expect(restoredDb.prepare(`
        SELECT request_schema_json FROM acp_interactions WHERE id = 'interaction-backup-owned-b'
      `).get().request_schema_json)
        .toBe('{"description":"Java password runpin","label":"alpha"}');
    } finally {
      restoredDb.close();
    }
  });

  it("restores ACP profiles, operations, and sanitized interactions without secret values", async () => {
    const dataDir = tmp("backup-acp-data");
    const outDir = tmp("backup-acp-out");
    const restoredDir = tmp("backup-acp-restored");
    const workspace = tmp("backup-acp-workspace");
    process.env.WORKLAB_DATA_DIR = dataDir;
    process.env.ACP_BACKUP_TOKEN = "backup-environment-secret";

    const sourceDb = openDb(join(dataDir, "worklab.db"));
    runMigrations(sourceDb);
    const profile = createAcpProfile({
      db: sourceDb,
      input: {
        agentName: "backup-acp",
        displayName: "Backup ACP",
        command: process.execPath,
        cwd: workspace,
        envKeys: ["ACP_BACKUP_TOKEN"],
      },
    });
    const legacyRawSessionId = "backup-legacy-raw-acp-session-secret";
    const legacyProtocolRequestId = `request:${legacyRawSessionId}:rpc`;
    const derivedOnlyRawSessionId = "backup-derived-only-raw-acp-session-secret";
    const validProviderSessionId = `acp:v1:${profile.id}:${Buffer.from(derivedOnlyRawSessionId).toString("base64url")}`;
    const v2ProviderSessionId = opaqueV2Token(
      "acp:v2:",
      profile.id,
      "backup-v2-provider-session-ciphertext",
    );
    const deepRawSessionId = "backup-deep-raw-acp-session-secret";
    const aliasSessionValues = [
      "backup-raw-camel-session-secret-493827",
      "backup-raw-snake-session-secret-493827",
      "backup-remote-camel-session-secret-493827",
      "backup-remote-snake-session-secret-493827",
      "backup-provider-camel-session-secret-493827",
      "backup-provider-snake-session-secret-493827",
    ];
    const privateUrl = "https://login.example/continue?code=BACKUP_PRIVATE_OAUTH_CODE_493827#BACKUP_PRIVATE_OAUTH_FRAGMENT_493827";
    const legacyOperationId = "acpop-backup-legacy-session";
    const legacyInteractionId = "interaction-backup-legacy-session";
    const legacyUrlInteractionId = "interaction-backup-legacy-url";
    sourceDb.prepare(`
      UPDATE acp_profiles
      SET last_probe_result_json = ?, last_probe_error_json = ?
      WHERE id = ?
    `).run(
      JSON.stringify({
        rawSessionId: aliasSessionValues[0],
        raw_session_id: aliasSessionValues[1],
        remoteSessionId: aliasSessionValues[2],
        remote_session_id: aliasSessionValues[3],
        providerSessionId: aliasSessionValues[4],
        provider_session_id: aliasSessionValues[5],
        status: aliasSessionValues.join(" "),
      }),
      JSON.stringify({ message: aliasSessionValues.join(" ") }),
      profile.id,
    );
    let delivered;
    const manager = createAcpOperationManager({
      db: sourceDb,
      controls: {
        authenticate: async ({ onInteraction }) => {
          delivered = await onInteraction({
            requestId: "backup-login-form",
            kind: "form",
            schema: {
              title: "Sign in",
              properties: {
                password: { type: "string", default: "backup-schema-secret" },
              },
            },
          });
          return { authenticated: true, accessToken: "backup-result-secret" };
        },
      },
    });
    const operation = manager.start({
      profileId: profile.id,
      kind: "authenticate",
      authMethodId: "backup-login",
    });
    let interaction;
    await vi.waitFor(() => {
      interaction = sourceDb.prepare(`
        SELECT * FROM acp_interactions WHERE operation_id = ? AND state = 'pending'
      `).get(operation.id);
      expect(interaction).toBeTruthy();
    });
    manager.respond({
      operationId: operation.id,
      interactionId: interaction.id,
      response: {
        disposition: "accept",
        values: { password: "backup-form-answer-secret" },
      },
    });
    await vi.waitFor(() => {
      expect(manager.get(operation.id)?.state).toBe("succeeded");
      expect(manager.isActive(operation.id)).toBe(false);
    });
    expect(delivered.content.password).toBe("backup-form-answer-secret");
    sourceDb.prepare(`
      INSERT INTO custom_providers
        (id, name, provider_type, base_url, api_key_encrypted, trust_public_url,
         enabled, status_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, '{}', ?, ?)
    `).run(
      "provider-backup",
      "Backup provider",
      "openai_compatible",
      "http://127.0.0.1:11434/v1",
      "backup-provider-credential-secret",
      Date.now(),
      Date.now(),
    );
    sourceDb.prepare(`
      INSERT INTO push_subscriptions
        (id, endpoint, keys_json, expiration_time, user_agent, client_kind,
         created_at, updated_at, last_seen_at)
      VALUES (?, ?, ?, NULL, '', 'pwa', ?, ?, ?)
    `).run(
      "push-backup",
      "https://push.example/backup-push-endpoint-secret",
      '{"p256dh":"backup-push-key-secret","auth":"backup-push-auth-secret"}',
      Date.now(),
      Date.now(),
      Date.now(),
    );
    sourceDb.prepare(`
      INSERT INTO tasks (id, task_key, title, instructions, created_at, updated_at)
      VALUES ('task-backup-webhook', 'T-BACKUP', 'Webhook task', 'Preserved task instructions', ?, ?)
    `).run(Date.now(), Date.now());
    sourceDb.prepare(`
      INSERT INTO acp_operations
        (id, profile_id, kind, state, remote_session_id, request_json, result_json,
         error_json, created_at, updated_at, started_at, completed_at)
      VALUES (?, ?, 'list_sessions', 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyOperationId,
      profile.id,
      legacyRawSessionId,
      JSON.stringify({ sessionId: legacyRawSessionId, copied: legacyRawSessionId }),
      JSON.stringify({
        sessions: [
          { id: legacyRawSessionId, providerSessionId: validProviderSessionId, title: legacyRawSessionId },
          { id: v2ProviderSessionId, title: "Preserved public v2 session history" },
        ],
      }),
      JSON.stringify({ message: `failed for ${legacyRawSessionId}` }),
      Date.now(),
      Date.now(),
      Date.now(),
      Date.now(),
    );
    sourceDb.prepare(`
      INSERT INTO acp_interactions
        (id, profile_id, operation_id, protocol_request_id, kind,
         request_schema_json, state, disposition, created_at, updated_at, resolved_at)
      VALUES (?, ?, ?, ?, 'form', ?, 'submitted', 'accept', ?, ?, ?)
    `).run(
      legacyInteractionId,
      profile.id,
      legacyOperationId,
      legacyProtocolRequestId,
      JSON.stringify({
        session_id: legacyRawSessionId,
        providerSessionId: validProviderSessionId,
        description: `${legacyRawSessionId} ${legacyProtocolRequestId}`,
      }),
      Date.now(),
      Date.now(),
      Date.now(),
    );
    sourceDb.prepare(`
      INSERT INTO acp_interactions
        (id, profile_id, operation_id, protocol_request_id, kind,
         request_schema_json, state, disposition, created_at, updated_at, resolved_at)
      VALUES (?, ?, ?, ?, 'url', ?, 'submitted', ?, ?, ?, ?)
    `).run(
      legacyUrlInteractionId,
      profile.id,
      legacyOperationId,
      privateUrl,
      JSON.stringify({ mode: "url", url: privateUrl, message: `Open ${privateUrl}` }),
      "BACKUP_PRIVATE_OAUTH_FRAGMENT_493827",
      Date.now(),
      Date.now(),
      Date.now(),
    );
    sourceDb.prepare(`
      INSERT INTO acp_interactions
        (id, profile_id, operation_id, protocol_request_id, kind,
         request_schema_json, state, disposition, created_at, updated_at, resolved_at)
      VALUES (?, ?, ?, ?, 'permission', '{}', 'submitted', 'accept', ?, ?, ?)
    `).run(
      "interaction-backup-safe-request",
      profile.id,
      operation.id,
      "ordinary-request-id-42",
      Date.now(),
      Date.now(),
      Date.now(),
    );
    sourceDb.prepare(`
      INSERT INTO task_runs
        (id, task_id, mode, stage, agent_name, provider_kind, started_at, status,
         process_status, error_text, summary, details, result_json, diagnostics_json,
         warnings_json, provider_session_id)
      VALUES (?, ?, 'execute', 'execute', ?, 'acp', ?, 'complete', 'succeeded', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "run-backup-acp-legacy",
      "task-backup-webhook",
      "backup-acp",
      Date.now(),
      `activity error ${legacyRawSessionId}`,
      `activity summary ${legacyRawSessionId} ${derivedOnlyRawSessionId}`,
      `activity details ${legacyProtocolRequestId}`,
      JSON.stringify({ copied: legacyRawSessionId }),
      JSON.stringify({ sessionId: legacyRawSessionId, providerSessionId: validProviderSessionId }),
      JSON.stringify({ sessionId: deepRawSessionId, copied: deepRawSessionId }),
      legacyRawSessionId,
    );
    sourceDb.prepare(`
      INSERT INTO task_runs
        (id, task_id, mode, stage, agent_name, provider_kind, started_at, status,
         process_status, diagnostics_json, provider_session_id)
      VALUES (?, ?, 'execute', 'execute', ?, 'acp', ?, 'complete', 'succeeded', ?, ?)
    `).run(
      "run-backup-acp-encoded",
      "task-backup-webhook",
      "backup-acp",
      Date.now(),
      JSON.stringify({ provider_session_id: v2ProviderSessionId }),
      v2ProviderSessionId,
    );
    sourceDb.prepare(`
      INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
      VALUES (?, ?, ?, 'complete', ?)
    `).run(
      "log-backup-acp-legacy",
      "run-backup-acp-legacy",
      JSON.stringify([{
        type: "acp_session_update",
        sessionId: legacyRawSessionId,
        providerSessionId: validProviderSessionId,
        text: `${legacyRawSessionId} ${legacyProtocolRequestId}`,
      }]),
      Date.now(),
    );
    sourceDb.prepare(`
      INSERT INTO task_comments (id, task_id, author_type, body, created_at)
      VALUES ('comment-backup-acp-legacy', 'task-backup-webhook', 'system', ?, ?)
    `).run(`Copied ${legacyRawSessionId} ${legacyProtocolRequestId} ${derivedOnlyRawSessionId}`, Date.now());
    sourceDb.prepare(`
      UPDATE tasks SET plan_body = ?, error_text = ?, pending_actions_json = ?
      WHERE id = 'task-backup-webhook'
    `).run(
      `Promoted ${legacyRawSessionId}`,
      `Failed ${derivedOnlyRawSessionId}`,
      JSON.stringify([{ label: legacyRawSessionId }]),
    );
    sourceDb.prepare(`
      INSERT INTO run_compactions (
        id, task_run_id, seq, trigger, summary, metadata_json, error_text, created_at
      ) VALUES ('compaction-backup-acp', 'run-backup-acp-legacy', 1, 'manual', ?, ?, ?, 1)
    `).run(
      `Summary ${legacyRawSessionId}`,
      JSON.stringify({ copied: derivedOnlyRawSessionId }),
      `Error ${legacyRawSessionId}`,
    );
    sourceDb.prepare(`
      INSERT INTO task_run_approvals (
        id, task_run_id, request_id, tool_name, arguments_summary, model,
        status, reason, requested_at
      ) VALUES ('approval-backup-acp', 'run-backup-acp-legacy', 'request-approval',
        'tool', ?, ?, 'denied', ?, 1)
    `).run(
      `Arguments ${legacyRawSessionId}`,
      `model-${derivedOnlyRawSessionId}`,
      `Reason ${legacyRawSessionId}`,
    );
    sourceDb.prepare(`
      INSERT INTO slack_delivery_log (
        id, task_run_id, target_type, text, status, error_text, response_json, created_at
      ) VALUES ('slack-backup-acp', 'run-backup-acp-legacy', 'channel', ?, 'failed', ?, ?, 1)
    `).run(
      `Text ${legacyRawSessionId}`,
      `Error ${derivedOnlyRawSessionId}`,
      JSON.stringify({ copied: legacyRawSessionId }),
    );
    sourceDb.prepare(`
      INSERT INTO agent_memories (
        id, agent_name, kind, scope, status, content, content_key, evidence,
        task_id, run_id, source, metadata_json, created_at, updated_at
      ) VALUES ('memory-backup-acp', 'backup-acp', 'learning', 'task', 'active', ?,
        'memory-backup-acp-key', ?, 'task-backup-webhook', 'run-backup-acp-legacy',
        'run', ?, 1, 1)
    `).run(
      `Learned ${legacyRawSessionId}`,
      `Evidence ${derivedOnlyRawSessionId}`,
      JSON.stringify({ copied: legacyRawSessionId }),
    );
    sourceDb.prepare(`
      INSERT INTO embeddings
        (id, kind, ref, source_ref, title, chunk_text, vector_present, content_hash,
         created_at, updated_at)
      VALUES (?, 'task_comment', ?, ?, 'Legacy ACP copy', ?, 0, 'legacy-acp-copy', ?, ?)
    `).run(
      "embedding-backup-acp-legacy",
      "comment-backup-acp-legacy",
      "comment-backup-acp-legacy#chunk-0",
      `Indexed ${legacyRawSessionId}`,
      Date.now(),
      Date.now(),
    );
    sourceDb.prepare(`
      INSERT INTO embeddings_fts (id, kind, source_ref, title, chunk_text)
      VALUES (?, 'task_comment', ?, 'Legacy ACP copy', ?)
    `).run(
      "embedding-backup-acp-legacy",
      "comment-backup-acp-legacy#chunk-0",
      `Indexed ${legacyRawSessionId}`,
    );
    sourceDb.prepare(`
      INSERT INTO embeddings
        (id, kind, ref, source_ref, title, chunk_text, vector_present, content_hash,
         created_at, updated_at)
      VALUES ('embedding-backup-memory', 'agent_memory', 'agent_memories/memory-backup-acp',
        'agent_memories/memory-backup-acp', 'Memory', ?, 0, 'memory-copy', 1, 1)
    `).run(`Learned ${legacyRawSessionId}`);
    sourceDb.prepare(`
      INSERT INTO embeddings_fts (id, kind, source_ref, title, chunk_text)
      VALUES ('embedding-backup-memory', 'agent_memory', 'agent_memories/memory-backup-acp',
        'Memory', ?)
    `).run(`Learned ${legacyRawSessionId}`);
    sourceDb.prepare(`
      INSERT INTO automations
        (id, task_id, title, instructions, tags, trigger_json, webhook_id, enabled,
         next_fire_at, last_status, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)
    `).run(
      "automation-backup-webhook",
      "task-backup-webhook",
      "Preserved webhook title",
      "Preserved webhook instructions",
      '["preserved-tag"]',
      '{"type":"webhook","webhook_id":"backup-webhook-capability-secret"}',
      "backup-webhook-capability-secret",
      "succeeded",
      "previous non-secret status detail",
      1_700_000_000_000,
      1_700_000_000_001,
    );
    sourceDb.close();

    const lines = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    await backup(["--out", outDir]);
    const archive = lines.find((line) => line.startsWith("backup: ")).replace("backup: ", "");
    execFileSync("tar", ["-xzf", archive, "-C", restoredDir]);

    const restoredDbPath = join(restoredDir, "worklab.db");
    const restoredDb = openDb(restoredDbPath);
    try {
      expect(restoredDb.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get().value)
        .toBe(String(SCHEMA_VERSION));
      expect(restoredDb.prepare("SELECT agent_name, env_keys_json FROM acp_profiles WHERE id = ?")
        .get(profile.id)).toEqual({
        agent_name: "backup-acp",
        env_keys_json: "[\"ACP_BACKUP_TOKEN\"]",
      });
      const restoredProbe = restoredDb.prepare(`
        SELECT last_probe_result_json, last_probe_error_json FROM acp_profiles WHERE id = ?
      `).get(profile.id);
      expect(JSON.parse(restoredProbe.last_probe_result_json)).toEqual({
        status: "[redacted] [redacted] [redacted] [redacted] [redacted] [redacted]",
      });
      expect(JSON.parse(restoredProbe.last_probe_error_json)).toEqual({
        message: "[redacted] [redacted] [redacted] [redacted] [redacted] [redacted]",
      });
      expect(restoredDb.prepare("SELECT kind, state, result_json FROM acp_operations WHERE id = ?")
        .get(operation.id)).toEqual({
        kind: "authenticate",
        state: "succeeded",
        result_json: "{\"authenticated\":true}",
      });
      expect(restoredDb.prepare(`
        SELECT kind, state, disposition, request_schema_json
        FROM acp_interactions WHERE id = ?
      `).get(interaction.id)).toEqual({
        kind: "form",
        state: "submitted",
        disposition: "accept",
        request_schema_json: "{\"title\":\"Sign in\",\"properties\":{\"password\":{\"type\":\"string\"}}}",
      });
      expect(restoredDb.prepare(`
        SELECT name, base_url, api_key_encrypted
        FROM custom_providers WHERE id = 'provider-backup'
      `).get()).toEqual({
        name: "Backup provider",
        base_url: "http://127.0.0.1:11434/v1",
        api_key_encrypted: null,
      });
      expect(restoredDb.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get().count).toBe(0);
      const restoredOperation = restoredDb.prepare(`
        SELECT remote_session_id, request_json, result_json, error_json
        FROM acp_operations WHERE id = ?
      `).get(legacyOperationId);
      expect(restoredOperation.remote_session_id).toBeNull();
      expect(JSON.stringify(restoredOperation)).not.toContain(legacyRawSessionId);
      expect(JSON.parse(restoredOperation.result_json)).toEqual({
        sessions: [
          { title: "[redacted]" },
          { title: "Preserved public v2 session history" },
        ],
      });
      expect(restoredOperation.result_json).not.toContain(validProviderSessionId);
      expect(restoredOperation.result_json).not.toContain(v2ProviderSessionId);

      const restoredInteraction = restoredDb.prepare(`
        SELECT protocol_request_id, request_schema_json FROM acp_interactions WHERE id = ?
      `).get(legacyInteractionId);
      expect(restoredInteraction.protocol_request_id).toBe(`backup:${legacyInteractionId}`);
      expect(JSON.stringify(restoredInteraction)).not.toContain(legacyRawSessionId);
      expect(JSON.stringify(restoredInteraction)).not.toContain(legacyProtocolRequestId);
      expect(restoredInteraction.request_schema_json).not.toContain(validProviderSessionId);
      expect(restoredDb.prepare(`
        SELECT protocol_request_id FROM acp_interactions WHERE id = 'interaction-backup-safe-request'
      `).get().protocol_request_id).toBe("ordinary-request-id-42");
      expect(restoredDb.prepare(`
        SELECT protocol_request_id, request_schema_json, disposition
        FROM acp_interactions WHERE id = ?
      `).get(legacyUrlInteractionId)).toEqual({
        protocol_request_id: expect.stringMatching(/^backup:url:[a-f0-9]{32}$/u),
        request_schema_json: JSON.stringify(ACP_URL_PUBLIC_REQUEST),
        disposition: null,
      });

      const restoredLegacyRun = restoredDb.prepare(`
        SELECT provider_session_id, error_text, summary, details, result_json, diagnostics_json, warnings_json
        FROM task_runs WHERE id = 'run-backup-acp-legacy'
      `).get();
      expect(restoredLegacyRun.provider_session_id).toBeNull();
      expect(JSON.stringify(restoredLegacyRun)).not.toContain(legacyRawSessionId);
      expect(JSON.stringify(restoredLegacyRun)).not.toContain(legacyProtocolRequestId);
      expect(restoredLegacyRun.diagnostics_json).not.toContain(validProviderSessionId);
      expect(JSON.parse(restoredLegacyRun.warnings_json)).toEqual({ copied: "[redacted]" });
      expect(restoredDb.prepare(`
        SELECT provider_session_id, diagnostics_json
        FROM task_runs WHERE id = 'run-backup-acp-encoded'
      `).get()).toEqual({
        provider_session_id: null,
        diagnostics_json: "{}",
      });
      const restoredEvents = restoredDb.prepare(`
        SELECT events FROM agent_logs WHERE id = 'log-backup-acp-legacy'
      `).get().events;
      expect(restoredEvents).not.toContain(legacyRawSessionId);
      expect(restoredEvents).not.toContain(legacyProtocolRequestId);
      expect(restoredEvents).not.toContain(validProviderSessionId);
      expect(restoredDb.prepare(`
        SELECT body FROM task_comments WHERE id = 'comment-backup-acp-legacy'
      `).get().body).toBe("Copied [redacted] request:[redacted]:rpc [redacted]");
      expect(restoredDb.prepare(`
        SELECT plan_body, error_text, pending_actions_json
        FROM tasks WHERE id = 'task-backup-webhook'
      `).get()).toEqual({
        plan_body: "Promoted [redacted]",
        error_text: "Failed [redacted]",
        pending_actions_json: '[{"label":"[redacted]"}]',
      });
      expect(restoredDb.prepare(`
        SELECT summary, metadata_json, error_text
        FROM run_compactions WHERE id = 'compaction-backup-acp'
      `).get()).toEqual({
        summary: "Summary [redacted]",
        metadata_json: '{"copied":"[redacted]"}',
        error_text: "Error [redacted]",
      });
      expect(restoredDb.prepare(`
        SELECT arguments_summary, model, reason
        FROM task_run_approvals WHERE id = 'approval-backup-acp'
      `).get()).toEqual({
        arguments_summary: "Arguments [redacted]",
        model: "model-[redacted]",
        reason: "Reason [redacted]",
      });
      expect(restoredDb.prepare(`
        SELECT text, error_text, response_json
        FROM slack_delivery_log WHERE id = 'slack-backup-acp'
      `).get()).toEqual({
        text: "Text [redacted]",
        error_text: "Error [redacted]",
        response_json: '{"copied":"[redacted]"}',
      });
      expect(restoredDb.prepare(`
        SELECT COUNT(*) AS count FROM agent_memories WHERE id = 'memory-backup-acp'
      `).get().count).toBe(0);
      expect(restoredDb.prepare(`
        SELECT COUNT(*) AS count FROM embeddings WHERE id = 'embedding-backup-acp-legacy'
      `).get().count).toBe(0);
      expect(restoredDb.prepare(`
        SELECT COUNT(*) AS count FROM embeddings WHERE id = 'embedding-backup-memory'
      `).get().count).toBe(0);
      expect(restoredDb.prepare(`
        SELECT task_id, title, instructions, tags, trigger_json, webhook_id, enabled,
               next_fire_at, last_status, last_error, created_at, updated_at
        FROM automations WHERE id = 'automation-backup-webhook'
      `).get()).toEqual({
        task_id: "task-backup-webhook",
        title: "Preserved webhook title",
        instructions: "Preserved webhook instructions",
        tags: '["preserved-tag"]',
        trigger_json: '{"type":"webhook","reconfiguration_required":true}',
        webhook_id: null,
        enabled: 0,
        next_fire_at: null,
        last_status: "succeeded",
        last_error: "Webhook credential omitted from backup; edit the automation to generate a new webhook ID.",
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_001,
      });
    } finally {
      restoredDb.close();
    }

    const restoredBytes = readFileSync(restoredDbPath);
    for (const secret of [
      "backup-environment-secret",
      "backup-schema-secret",
      "backup-form-answer-secret",
      "backup-result-secret",
      "backup-provider-credential-secret",
      "backup-push-endpoint-secret",
      "backup-push-key-secret",
      "backup-push-auth-secret",
      "backup-webhook-capability-secret",
      legacyRawSessionId,
      legacyProtocolRequestId,
      derivedOnlyRawSessionId,
      deepRawSessionId,
      validProviderSessionId,
      v2ProviderSessionId,
      ...aliasSessionValues,
      privateUrl,
      "BACKUP_PRIVATE_OAUTH_CODE_493827",
      "BACKUP_PRIVATE_OAUTH_FRAGMENT_493827",
    ]) {
      expect(restoredBytes.includes(Buffer.from(secret))).toBe(false);
    }
  });
});

describe("service file generators", () => {
  it("renders launchd and systemd units with the Worklab CLI", () => {
    const params = {
      node: "/usr/bin/node",
      cli: "/repo/src/cli/index.js",
      cwd: "/repo",
      dataDir: "/data",
      env: {
        WORKLAB_DATA_DIR: "/data",
        WORKLAB_HOST: "127.0.0.1",
        WORKLAB_PORT: "9000",
        WORKLAB_WORKSPACE: "/workspace",
        WORKLAB_LOG_LEVEL: "info",
        PATH: "/usr/bin",
      },
    };

    expect(launchdPlist(params)).toContain("<string>/repo/src/cli/index.js</string>");
    expect(launchdPlist(params)).toContain("<key>KeepAlive</key><true/>");
    expect(systemdUnit(params)).toContain("ExecStart=/usr/bin/node /repo/src/cli/index.js serve");
    expect(systemdUnit(params)).toContain("Restart=always");
    expect(systemdUnit(params)).toContain("TimeoutStopSec=70s");
    expect(systemdUnit(params)).toContain("WORKLAB_DATA_DIR=/data");
    expect(systemdUnit(params)).toContain("WORKLAB_PORT=9000");
  });

  it("includes drain timeout in generated service environments", () => {
    const params = serviceParams({
      repoRoot: "/repo",
      dataDir: "/data",
      host: "127.0.0.1",
      port: 9000,
      workspace: "/workspace",
      logLevel: "info",
      drainTimeoutMs: 30000,
    });

    expect(params.env.WORKLAB_DRAIN_TIMEOUT_MS).toBe("30000");
    expect(launchdPlist(params)).toContain("<key>WORKLAB_DRAIN_TIMEOUT_MS</key><string>30000</string>");
    expect(systemdUnit(params)).toContain("WORKLAB_DRAIN_TIMEOUT_MS=30000");
    expect(systemdUnit(params)).toContain("TimeoutStopSec=40s");
  });
});
