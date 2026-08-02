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
import { createAcpOperationManager } from "../../coordinator/acp-operation-manager.js";

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
    const deepRawSessionId = "backup-deep-raw-acp-session-secret";
    const legacyOperationId = "acpop-backup-legacy-session";
    const legacyInteractionId = "interaction-backup-legacy-session";
    let hostileDeepPayload = { sessionId: deepRawSessionId };
    for (let depth = 0; depth < 40; depth += 1) hostileDeepPayload = { nested: hostileDeepPayload };
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
    expect(delivered.values.password).toBe("backup-form-answer-secret");
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
        sessions: [{ id: legacyRawSessionId, providerSessionId: validProviderSessionId, title: legacyRawSessionId }],
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
      JSON.stringify(hostileDeepPayload),
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
      JSON.stringify({ provider_session_id: validProviderSessionId }),
      validProviderSessionId,
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
      expect(restoredOperation.result_json).toContain(validProviderSessionId);

      const restoredInteraction = restoredDb.prepare(`
        SELECT protocol_request_id, request_schema_json FROM acp_interactions WHERE id = ?
      `).get(legacyInteractionId);
      expect(restoredInteraction.protocol_request_id).toBe(`backup:${legacyInteractionId}`);
      expect(JSON.stringify(restoredInteraction)).not.toContain(legacyRawSessionId);
      expect(JSON.stringify(restoredInteraction)).not.toContain(legacyProtocolRequestId);
      expect(restoredInteraction.request_schema_json).toContain(validProviderSessionId);
      expect(restoredDb.prepare(`
        SELECT protocol_request_id FROM acp_interactions WHERE id = 'interaction-backup-safe-request'
      `).get().protocol_request_id).toBe("ordinary-request-id-42");

      const restoredLegacyRun = restoredDb.prepare(`
        SELECT provider_session_id, error_text, summary, details, result_json, diagnostics_json, warnings_json
        FROM task_runs WHERE id = 'run-backup-acp-legacy'
      `).get();
      expect(restoredLegacyRun.provider_session_id).toBeNull();
      expect(JSON.stringify(restoredLegacyRun)).not.toContain(legacyRawSessionId);
      expect(JSON.stringify(restoredLegacyRun)).not.toContain(legacyProtocolRequestId);
      expect(restoredLegacyRun.diagnostics_json).toContain(validProviderSessionId);
      expect(JSON.parse(restoredLegacyRun.warnings_json)).toEqual({
        redacted: true,
        reason: "ACP session data exceeded backup scrub limits",
      });
      expect(restoredDb.prepare(`
        SELECT provider_session_id, diagnostics_json
        FROM task_runs WHERE id = 'run-backup-acp-encoded'
      `).get()).toEqual({
        provider_session_id: validProviderSessionId,
        diagnostics_json: JSON.stringify({ provider_session_id: validProviderSessionId }),
      });
      const restoredEvents = restoredDb.prepare(`
        SELECT events FROM agent_logs WHERE id = 'log-backup-acp-legacy'
      `).get().events;
      expect(restoredEvents).not.toContain(legacyRawSessionId);
      expect(restoredEvents).not.toContain(legacyProtocolRequestId);
      expect(restoredEvents).toContain(validProviderSessionId);
      expect(restoredDb.prepare(`
        SELECT body FROM task_comments WHERE id = 'comment-backup-acp-legacy'
      `).get().body).toBe("Copied [redacted] request:[redacted]:rpc [redacted]");
      expect(restoredDb.prepare(`
        SELECT COUNT(*) AS count FROM embeddings WHERE id = 'embedding-backup-acp-legacy'
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
