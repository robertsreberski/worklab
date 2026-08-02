import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAcpProfileBinding,
  createAcpProfile,
  deleteAcpProfileRecord,
  getAcpProfile,
  normalizeMonoDiscovery,
  updateAcpProfileRecord,
} from "../../core/acp-profiles.js";
import { makeTestDb } from "../helpers/test-db.js";

const cleanup = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name = "acp-profile") {
  const dir = mkdtempSync(join(tmpdir(), `worklab-${name}-`));
  cleanup.push(dir);
  return dir;
}

function monoDescriptor(workspace, overrides = {}) {
  return {
    schema: "mono-agent.acp-source.v1",
    bridgeVersion: 1,
    protocolVersion: 1,
    installedVersion: "0.18.0",
    sourceId: "personal-agent",
    label: "Personal Agent",
    health: "running",
    compatible: true,
    workspace: { path: workspace, owner: "agent" },
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
    ...overrides,
  };
}

describe("ACP profile persistence", () => {
  it("normalizes a generic command and atomically binds an ACP agent", () => {
    const db = makeTestDb();
    const cwd = tempDir();
    const profile = createAcpProfile({
      db,
      input: {
        agentName: "external-coder",
        displayName: "External Coder",
        description: "Runs over ACP",
        command: process.execPath,
        args: ["bridge.mjs", "--stdio"],
        cwd,
        envKeys: ["Z_TOKEN_NAME", "A_ENDPOINT", "Z_TOKEN_NAME"],
        permissionsPolicy: { filesystem: false, terminal: false, network: true, mcp: false },
      },
    });

    expect(profile.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    expect(profile).toMatchObject({
      agentName: "external-coder",
      driver: "generic",
      command: expect.stringMatching(/^\//u),
      args: ["bridge.mjs", "--stdio"],
      cwd: realpathSync(cwd),
      envKeys: ["A_ENDPOINT", "Z_TOKEN_NAME"],
      configurationOwner: "client",
      workspaceOwner: "client",
      mcpOwner: "client",
      permissionsPolicy: { filesystem: false, terminal: false, network: true, mcp: false },
      probeTimeoutMs: 30_000,
      agent: {
        agentName: "external-coder",
        sdk: "acp",
        executionMode: "acp",
        model: `acp:${profile.id}`,
        enabled: true,
      },
    });
    expect(assertAcpProfileBinding({ db, id: profile.id }).id).toBe(profile.id);
    const raw = db.prepare("SELECT env_keys_json FROM acp_profiles WHERE id = ?").get(profile.id);
    expect(JSON.parse(raw.env_keys_json)).toEqual(["A_ENDPOINT", "Z_TOKEN_NAME"]);
  });

  it("rejects command ambiguity, env values, secret-bearing policy fields, and invalid bounds", () => {
    const db = makeTestDb();
    const cwd = tempDir();
    const base = {
      agentName: "external",
      displayName: "External",
      command: process.execPath,
      cwd,
    };

    expect(() => createAcpProfile({ db, input: { ...base, command: "node" } }))
      .toThrow(/absolute path/i);
    expect(() => createAcpProfile({ db, input: { ...base, env: { API_TOKEN: "secret" } } }))
      .toThrow(/envKeys names only/i);
    expect(() => createAcpProfile({ db, input: { ...base, envKeys: ["VALID", "BAD-NAME"] } }))
      .toThrow(/envKeys\[1\]/i);
    expect(() => createAcpProfile({
      db,
      input: { ...base, sessionPolicy: { accessToken: "secret" } },
    })).toThrow(/secret material/i);
    expect(() => createAcpProfile({ db, input: { ...base, probeTimeoutMs: 999 } }))
      .toThrow(/1000.*300000/i);
    for (const capability of ["filesystem", "terminal", "mcp"]) {
      expect(() => createAcpProfile({
        db,
        input: {
          ...base,
          permissionsPolicy: {
            filesystem: capability === "filesystem",
            terminal: capability === "terminal",
            network: false,
            mcp: capability === "mcp",
          },
        },
      })).toThrow(new RegExp(`does not support ACP client ${capability}`, "i"));
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM agents").get().count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM acp_profiles").get().count).toBe(0);
  });

  it("imports only a sanitized compatible mono descriptor and forces agent ownership", () => {
    const db = makeTestDb();
    const workspace = tempDir("mono-workspace");
    const descriptor = monoDescriptor(workspace);
    const discovery = normalizeMonoDiscovery({
      schema: "mono-agent.acp-discovery.v1",
      bridgeVersion: 1,
      protocolVersion: 1,
      sources: [{
        ...descriptor,
        operatorUrl: "http://127.0.0.1:1234",
        apiKey: "must-not-survive",
        configPath: "/private/config.json",
      }],
    });
    expect(discovery.sources[0]).toEqual(descriptor);
    expect(JSON.stringify(discovery)).not.toMatch(/must-not-survive|operatorUrl|apiKey|configPath/u);

    for (const input of [
      { sourceId: "personal-agent", sessionPolicy: {} },
      { sourceId: "personal-agent", probeTimeoutMs: 30_000 },
    ]) {
      expect(() => createAcpProfile({
        db,
        input,
        mono: { descriptor: discovery.sources[0], command: process.execPath, args: ["bridge", "acp"] },
      })).toThrow(/fixed by the mono source descriptor/i);
    }

    const profile = createAcpProfile({
      db,
      input: { sourceId: "personal-agent" },
      mono: { descriptor: discovery.sources[0], command: process.execPath, args: ["bridge", "acp"] },
    });
    expect(profile).toMatchObject({
      driver: "mono",
      monoSourceId: "personal-agent",
      monoSource: descriptor,
      cwd: workspace,
      canonicalWorkspace: workspace,
      configurationOwner: "agent",
      workspaceOwner: "agent",
      mcpOwner: "agent",
      permissionsPolicy: { filesystem: false, terminal: false, network: false, mcp: false },
      configPolicy: descriptor.constraints,
    });
    const stored = db.prepare("SELECT mono_source_json FROM acp_profiles WHERE id = ?").get(profile.id);
    expect(stored.mono_source_json).toBe(JSON.stringify(descriptor));

    expect(() => updateAcpProfileRecord({
      db,
      id: profile.id,
      input: { permissionsPolicy: { filesystem: true, terminal: false, network: false, mcp: false } },
    })).toThrow(/fixed by the mono source descriptor/i);
    for (const input of [
      { sessionPolicy: {} },
      { session_policy: {} },
      { probeTimeoutMs: 30_000 },
      { probe_timeout_ms: 30_000 },
    ]) {
      expect(() => updateAcpProfileRecord({ db, id: profile.id, input }))
        .toThrow(/fixed by the mono source descriptor/i);
    }

    const localMetadata = updateAcpProfileRecord({
      db,
      id: profile.id,
      input: {
        displayName: "My Personal Agent",
        description: "Local Worklab label",
        enabled: false,
      },
    });
    expect(localMetadata.agent).toMatchObject({
      displayName: "My Personal Agent",
      description: "Local Worklab label",
      enabled: false,
    });
  });

  it("keeps legacy mono sources visible but rejects their import", () => {
    const db = makeTestDb();
    const workspace = tempDir("legacy-mono-workspace");
    const compatible = monoDescriptor(workspace);
    const legacy = monoDescriptor(workspace, {
      bridgeVersion: 0,
      protocolVersion: 0,
      installedVersion: "unknown",
      sourceId: "legacy-agent",
      label: "Legacy Agent",
      compatible: false,
      warnings: ["bridge_metadata_missing_or_invalid"],
    });
    const discovery = normalizeMonoDiscovery({
      schema: "mono-agent.acp-discovery.v1",
      bridgeVersion: 1,
      protocolVersion: 1,
      sources: [legacy, compatible],
    });

    expect(discovery.sources).toEqual([legacy, compatible]);
    expect(() => createAcpProfile({
      db,
      input: { sourceId: "legacy-agent" },
      mono: { descriptor: discovery.sources[0], command: process.execPath, args: ["bridge", "acp"] },
    })).toThrow(/not ACP-compatible/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM acp_profiles").get().count).toBe(0);
  });

  it("updates identity and generic policy without breaking the profile binding", () => {
    const db = makeTestDb();
    const cwd = tempDir();
    const profile = createAcpProfile({
      db,
      input: {
        agentName: "external",
        displayName: "Old Name",
        command: process.execPath,
        cwd,
      },
    });
    const updated = updateAcpProfileRecord({
      db,
      id: profile.id,
      input: {
        displayName: "New Name",
        enabled: false,
        configPolicy: { promptContent: ["text"] },
        probeTimeoutMs: 45_000,
      },
    });
    expect(updated).toMatchObject({
      probeTimeoutMs: 45_000,
      configPolicy: { promptContent: ["text"] },
      agent: { displayName: "New Name", enabled: false, sdk: "acp", executionMode: "acp" },
    });
    expect(updated.agent.model).toBe(`acp:${profile.id}`);
  });

  it("rejects unsupported client capabilities when patching a generic profile", () => {
    const db = makeTestDb();
    const cwd = tempDir();
    const profile = createAcpProfile({
      db,
      input: { agentName: "external", displayName: "External", command: process.execPath, cwd },
    });
    for (const capability of ["filesystem", "terminal", "mcp"]) {
      expect(() => updateAcpProfileRecord({
        db,
        id: profile.id,
        input: {
          permissionsPolicy: {
            filesystem: capability === "filesystem",
            terminal: capability === "terminal",
            network: false,
            mcp: capability === "mcp",
          },
        },
      })).toThrow(new RegExp(`does not support ACP client ${capability}`, "i"));
    }
  });

  it("deletes the dedicated ACP agent only while it is unreferenced", () => {
    const db = makeTestDb();
    const cwd = tempDir();
    const profile = createAcpProfile({
      db,
      input: { agentName: "external", displayName: "External", command: process.execPath, cwd },
    });
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, title, owner_agent, created_at, updated_at)
      VALUES ('task-acp', 'Uses ACP', 'external', ?, ?)
    `).run(now, now);
    let error;
    try {
      deleteAcpProfileRecord({ db, id: profile.id });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "profile_in_use", status: 409 });
    expect(getAcpProfile({ db, id: profile.id })).not.toBeNull();

    db.prepare("DELETE FROM tasks WHERE id = 'task-acp'").run();
    expect(deleteAcpProfileRecord({ db, id: profile.id })).toEqual({
      id: profile.id,
      agentName: "external",
    });
    expect(getAcpProfile({ db, id: profile.id })).toBeNull();
    expect(db.prepare("SELECT name FROM agents WHERE name = 'external'").get()).toBeUndefined();
  });

  it("requires mono workspace paths to exist before import", () => {
    const db = makeTestDb();
    const base = tempDir();
    const missing = join(base, "missing");
    expect(() => createAcpProfile({
      db,
      input: { sourceId: "personal-agent" },
      mono: { descriptor: monoDescriptor(missing), command: process.execPath },
    })).toThrow(/workspace\.path must resolve to a directory/i);

    const workspace = join(base, "workspace");
    mkdirSync(workspace);
    expect(() => createAcpProfile({
      db,
      input: { sourceId: "personal-agent" },
      mono: {
        descriptor: monoDescriptor(workspace, { compatible: false }),
        command: process.execPath,
      },
    })).toThrow(/not ACP-compatible/i);
  });
});
