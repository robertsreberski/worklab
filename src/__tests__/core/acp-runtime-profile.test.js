import { describe, expect, it, vi } from "vitest";

import {
  createMonoAcpDiscoveryControls,
  createWorklabAcpProfileResolver,
  resolveExecutable,
} from "../../core/acp-runtime-profile.js";
import { createAcpProfile } from "../../core/acp-profiles.js";
import { makeTestDb } from "../helpers/test-db.js";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

function createGeneric(db, overrides = {}) {
  return createAcpProfile({
    db,
    input: {
      agentName: "external",
      displayName: "External",
      command: process.execPath,
      cwd: "/tmp",
      envKeys: ["TEST_ACP_TOKEN"],
      ...overrides,
    },
    id: PROFILE_ID,
  });
}

describe("Worklab ACP runtime profiles", () => {
  it("resolves only named environment values and enables interaction capabilities", async () => {
    const db = makeTestDb();
    try {
      createGeneric(db);
      const resolveProfile = createWorklabAcpProfileResolver({
        db,
        env: { TEST_ACP_TOKEN: "private", UNLISTED_SECRET: "no" },
        urlHandoffAvailable: true,
      });
      const descriptor = await resolveProfile(PROFILE_ID);
      expect(descriptor.env).toEqual({ TEST_ACP_TOKEN: "private" });
      expect(descriptor.env).not.toHaveProperty("UNLISTED_SECRET");
      expect(descriptor.capabilityPolicy).toMatchObject({
        terminal: false,
        elicitation: { form: true, url: true },
        mcp: { stdio: false },
      });
      expect(descriptor.process).toMatchObject({ requestTimeoutMs: 0, maxLineBytes: 16 * 1024 * 1024 });
    } finally {
      db.close();
    }
  });

  it("does not advertise URL elicitations without a private handoff channel", async () => {
    const db = makeTestDb();
    try {
      createGeneric(db);
      const descriptor = await createWorklabAcpProfileResolver({
        db,
        env: { TEST_ACP_TOKEN: "private" },
      })(PROFILE_ID);
      expect(descriptor.capabilityPolicy.elicitation).toEqual({ form: true, url: false });
    } finally {
      db.close();
    }
  });

  it("requires enabled profiles for runs while allowing explicit management operations", async () => {
    const db = makeTestDb();
    try {
      const profile = createGeneric(db);
      db.prepare("UPDATE agents SET enabled = 0 WHERE name = ?").run(profile.agentName);
      const resolveProfile = createWorklabAcpProfileResolver({
        db,
        env: { TEST_ACP_TOKEN: "private" },
      });

      for (const operation of [
        "probe",
        "authenticate",
        "logout",
        "list_sessions",
        "delete_session",
      ]) {
        await expect(resolveProfile(PROFILE_ID, { operation }))
          .resolves.toMatchObject({ command: process.execPath });
      }
      for (const context of [
        undefined,
        { operation: "connect" },
        { operation: "run" },
        { operation: "unknown" },
      ]) {
        await expect(resolveProfile(PROFILE_ID, context))
          .rejects.toMatchObject({ code: "profile_disabled" });
      }
    } finally {
      db.close();
    }
  });

  it("fails safely for missing environment or unsupported client capabilities", async () => {
    const missingDb = makeTestDb();
    try {
      createGeneric(missingDb);
      await expect(createWorklabAcpProfileResolver({ db: missingDb, env: {} })(PROFILE_ID))
        .rejects.toMatchObject({ code: "environment_missing" });
    } finally {
      missingDb.close();
    }

    const unsupportedDb = makeTestDb();
    try {
      createGeneric(unsupportedDb, { envKeys: [] });
      unsupportedDb.prepare(`
        UPDATE acp_profiles
        SET permissions_policy_json = '{"filesystem":false,"terminal":false,"network":true,"mcp":false}'
        WHERE id = ?
      `).run(PROFILE_ID);
      await expect(createWorklabAcpProfileResolver({ db: unsupportedDb, env: {} })(PROFILE_ID))
        .rejects.toMatchObject({ code: "capability_unsupported" });
    } finally {
      unsupportedDb.close();
    }
  });

  it("uses the host allowlist for mono runtime processes", async () => {
    const db = makeTestDb();
    try {
      createAcpProfile({
        db,
        input: { sourceId: "personal" },
        mono: {
          command: process.execPath,
          args: ["bridge", "acp", "--source-id", "personal"],
          envKeys: ["HOME", "PATH"],
          descriptor: {
            schema: "mono-agent.acp-source.v1",
            bridgeVersion: 1,
            protocolVersion: 1,
            installedVersion: "0.18.0",
            sourceId: "personal",
            label: "Personal",
            health: "running",
            compatible: true,
            workspace: { path: "/tmp", owner: "agent" },
            ownership: { configuration: "agent", workspace: "agent", mcp: "agent" },
            constraints: {
              promptContent: ["text", "resource_link"],
              clientMcp: false,
              clientFilesystem: false,
              clientTerminal: false,
              attachments: false,
              additionalDirectories: false,
            },
            warnings: [],
          },
        },
        id: PROFILE_ID,
      });
      const resolveProfile = createWorklabAcpProfileResolver({
        db,
        env: {
          HOME: "/tmp/home",
          PATH: "/usr/bin",
          TMPDIR: "/tmp/acp",
          MONO_AGENT_TRACE_REGISTRY_DIR: "/tmp/trace-sources",
          WORKLAB_MONO_AGENT_BIN: "/tmp/mono-agent",
          WORKLAB_SERVICE_TOKEN: "sentinel-service-secret",
          OPENAI_API_KEY: "sentinel-provider-secret",
        },
      });
      const profile = await resolveProfile(PROFILE_ID);
      expect(profile.env).toEqual({
        HOME: "/tmp/home",
        PATH: "/usr/bin",
        TMPDIR: "/tmp/acp",
        MONO_AGENT_TRACE_REGISTRY_DIR: "/tmp/trace-sources",
      });
      expect(JSON.stringify(profile.env)).not.toMatch(/sentinel|WORKLAB_MONO_AGENT_BIN/u);
    } finally {
      db.close();
    }
  });

  it("builds exact mono bridge argv from sanitized discovery", async () => {
    const descriptor = {
      sourceId: "personal",
      compatible: true,
      health: "running",
      workspace: { path: "/tmp", owner: "agent" },
    };
    const discover = vi.fn().mockResolvedValue({ sources: [descriptor] });
    const controls = createMonoAcpDiscoveryControls({
      env: {
        WORKLAB_MONO_AGENT_BIN: process.execPath,
        PATH: process.env.PATH,
        HOME: "/tmp/home",
        TMPDIR: "/tmp/acp",
        WORKLAB_SERVICE_TOKEN: "sentinel-secret",
        ANTHROPIC_API_KEY: "sentinel-provider-secret",
      },
      discover,
    });
    const controller = new AbortController();
    await expect(controls.resolveMonoSource({
      sourceId: "personal",
      signal: controller.signal,
      timeoutMs: 12_345,
    })).resolves.toEqual({
      descriptor,
      command: resolveExecutable(process.execPath),
      args: ["bridge", "acp", "--source-id", "personal"],
      envKeys: ["HOME", "PATH", "TMPDIR"],
    });
    expect(discover).toHaveBeenCalledWith({
      signal: controller.signal,
      timeoutMs: 12_345,
      command: resolveExecutable(process.execPath),
      env: { HOME: "/tmp/home", PATH: process.env.PATH, TMPDIR: "/tmp/acp" },
    });

    discover.mockResolvedValueOnce({
      sources: [{ ...descriptor, health: "stale" }],
    });
    await expect(controls.resolveMonoSource({ sourceId: "personal" }))
      .rejects.toMatchObject({ code: "source_not_running" });
  });

  it("binds discovery and launch to one executable resolution per call", async () => {
    const descriptor = {
      sourceId: "personal",
      compatible: true,
      health: "running",
      workspace: { path: "/tmp", owner: "agent" },
    };
    const discover = vi.fn().mockResolvedValue({ sources: [descriptor] });
    const resolveExecutableImpl = vi.fn()
      .mockReturnValueOnce("/resolved/mono-agent-A")
      .mockReturnValueOnce("/resolved/mono-agent-B");
    const controls = createMonoAcpDiscoveryControls({
      command: "/configured/mono-agent-link",
      env: { PATH: "/configured" },
      discover,
      resolveExecutableImpl,
    });

    await expect(controls.resolveMonoSource({ sourceId: "personal" })).resolves.toMatchObject({
      command: "/resolved/mono-agent-A",
      args: ["bridge", "acp", "--source-id", "personal"],
    });
    expect(resolveExecutableImpl).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenLastCalledWith({
      signal: undefined,
      timeoutMs: undefined,
      command: "/resolved/mono-agent-A",
      env: { PATH: "/configured" },
    });

    await controls.discoverMono();
    expect(resolveExecutableImpl).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenLastCalledWith({
      command: "/resolved/mono-agent-B",
      env: { PATH: "/configured" },
    });
  });
});
