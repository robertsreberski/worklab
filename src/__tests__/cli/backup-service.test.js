import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "../../cli/backup.js";
import { launchdPlist, serviceParams, systemdUnit } from "../../cli/install-service.js";
import { createAcpProfile } from "../../core/acp-profiles.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
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

  it("creates a local tarball and excludes runtime logs", async () => {
    const dataDir = tmp("backup-data");
    const outDir = tmp("backup-out");
    mkdirSync(join(dataDir, "knowledge"), { recursive: true });
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    writeFileSync(join(dataDir, "knowledge", "note.md"), "hello");
    writeFileSync(join(dataDir, "logs", "worklab.out.log"), "runtime");
    process.env.WORKLAB_DATA_DIR = dataDir;

    const lines = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    await backup(["--out", outDir]);

    const archive = lines.find((line) => line.startsWith("backup: ")).replace("backup: ", "");
    expect(existsSync(archive)).toBe(true);
    const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(listing).toContain("./knowledge/note.md");
    expect(listing).not.toContain("logs/worklab.out.log");
    expect(lines.find((line) => line.startsWith("restore: "))).toContain(dataDir);
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
        .toBe("49");
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
    } finally {
      restoredDb.close();
    }

    const restoredBytes = readFileSync(restoredDbPath);
    for (const secret of [
      "backup-environment-secret",
      "backup-schema-secret",
      "backup-form-answer-secret",
      "backup-result-secret",
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
