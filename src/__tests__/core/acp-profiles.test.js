import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

  it("treats argv as non-secret configuration and rejects obvious credential flags", () => {
    const db = makeTestDb();
    const cwd = tempDir();
    const sentinel = "SENTINEL_ACP_SECRET_MUST_NOT_PERSIST";
    const base = {
      agentName: "external",
      displayName: "External",
      command: process.execPath,
      cwd,
    };
    const rejectedArgs = [
      ["--api-key", sentinel],
      [`--api_key=${sentinel}`],
      ["--apiKey", sentinel],
      ["--token", sentinel],
      [`--access-token=${sentinel}`],
      ["--secret", sentinel],
      ["--client-secret", sentinel],
      [`--client_secret=${sentinel}`],
      ["--password", sentinel],
      ["--credential", sentinel],
      [`--credentials=${sentinel}`],
      ["--authorization", sentinel],
      [`--auth=${sentinel}`],
      [`--authentication-header=${sentinel}`],
      ["--bearer", sentinel],
      [`--pass_phrase=${sentinel}`],
      ["--private-key", sentinel],
      [`--privateKeyPath=${sentinel}`],
      ["--access-key", sentinel],
      [`--accessKeyId=${sentinel}`],
      [`--cookie=${sentinel}`],
    ];

    for (const args of rejectedArgs) {
      expect(() => createAcpProfile({ db, input: { ...base, args } }))
        .toThrow(/secret-bearing flag.*envKeys names only/i);
    }
    for (const configPolicy of [
      { endpoint: sentinel },
      { options: { value: sentinel } },
      [],
      null,
    ]) {
      expect(() => createAcpProfile({ db, input: { ...base, configPolicy } }))
        .toThrow(/configPolicy is reserved and must be an empty object/i);
    }
    expect(() => createAcpProfile({
      db,
      input: {
        ...base,
        sessionPolicy: { configOptions: { endpoint: sentinel } },
      },
    })).toThrow(/sessionPolicy has unsupported fields: configOptions/i);
    for (const sessionPolicy of [
      { resumeStrategy: "restart" },
      { modeId: 42 },
      { modeId: "x".repeat(201) },
      { resumeStrategy: "auto", arbitraryOptions: { value: sentinel } },
    ]) {
      expect(() => createAcpProfile({ db, input: { ...base, sessionPolicy } }))
        .toThrow(/sessionPolicy/i);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM acp_profiles").get()).toEqual({ count: 0 });

    const profile = createAcpProfile({
      db,
      input: {
        ...base,
        args: ["bridge.mjs", "--stdio"],
        envKeys: ["ACP_API_TOKEN"],
        configPolicy: {},
        sessionPolicy: { resume_strategy: "load", mode_id: "review" },
      },
    });
    const stored = db.prepare("SELECT * FROM acp_profiles WHERE id = ?").get(profile.id);
    expect(profile.configPolicy).toEqual({});
    expect(profile.sessionPolicy).toEqual({ resumeStrategy: "load", modeId: "review" });
    expect(stored.config_policy_json).toBe("{}");
    expect(stored.session_policy_json).toBe(JSON.stringify({ resumeStrategy: "load", modeId: "review" }));
    expect(JSON.stringify({ profile, stored })).not.toContain(sentinel);
  });

  it("rejects an ordinary-agent name collision without rewriting the agent or its task and team references", () => {
    const db = makeTestDb();
    const cwd = tempDir();
    const now = Date.now();
    db.prepare(`
      INSERT INTO agents (
        name, display_name, description, sdk, model, execution_mode, enabled,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "existing-worker",
      "Existing Worker",
      "Original ordinary agent",
      "pi",
      "pi:openai:gpt-5.5",
      "sdk",
      1,
      now,
      now,
    );
    db.prepare(`
      INSERT INTO teams (id, slug, name, lead_agent, created_at, updated_at)
      VALUES ('team-existing', 'team-existing', 'Existing Team', 'existing-worker', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO team_members (team_id, agent_name, role_description, created_at)
      VALUES ('team-existing', 'existing-worker', 'Original member', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO tasks (
        id, team_id, title, delegated_to_agent, owner_agent, planner_agent,
        reviewer_agent, created_at, updated_at
      ) VALUES (
        'task-existing', 'team-existing', 'Existing task', 'existing-worker',
        'existing-worker', 'existing-worker', 'existing-worker', ?, ?
      )
    `).run(now, now);

    const beforeAgent = db.prepare("SELECT * FROM agents WHERE name = 'existing-worker'").get();
    let error;
    try {
      createAcpProfile({
        db,
        input: {
          agentName: "existing-worker",
          displayName: "Replacement ACP Agent",
          description: "Must not replace the ordinary agent",
          command: process.execPath,
          cwd,
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "conflict", status: 409 });
    expect(error.message).toMatch(/agent name already exists/i);
    expect(db.prepare("SELECT * FROM agents WHERE name = 'existing-worker'").get()).toEqual(beforeAgent);
    expect(db.prepare(`
      SELECT delegated_to_agent, owner_agent, planner_agent, reviewer_agent
      FROM tasks WHERE id = 'task-existing'
    `).get()).toEqual({
      delegated_to_agent: "existing-worker",
      owner_agent: "existing-worker",
      planner_agent: "existing-worker",
      reviewer_agent: "existing-worker",
    });
    expect(db.prepare("SELECT lead_agent FROM teams WHERE id = 'team-existing'").get())
      .toEqual({ lead_agent: "existing-worker" });
    expect(db.prepare("SELECT agent_name FROM team_members WHERE team_id = 'team-existing'").get())
      .toEqual({ agent_name: "existing-worker" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM acp_profiles").get()).toEqual({ count: 0 });
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
    const canonicalWorkspace = realpathSync(workspace);
    const importedDescriptor = {
      ...descriptor,
      workspace: { ...descriptor.workspace, path: canonicalWorkspace },
    };
    expect(profile).toMatchObject({
      driver: "mono",
      monoSourceId: "personal-agent",
      monoSource: importedDescriptor,
      cwd: canonicalWorkspace,
      canonicalWorkspace,
      configurationOwner: "agent",
      workspaceOwner: "agent",
      mcpOwner: "agent",
      permissionsPolicy: { filesystem: false, terminal: false, network: false, mcp: false },
      configPolicy: descriptor.constraints,
    });
    const stored = db.prepare("SELECT mono_source_json FROM acp_profiles WHERE id = ?").get(profile.id);
    expect(stored.mono_source_json).toBe(JSON.stringify(importedDescriptor));

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

  it("keeps stale legacy mono sources with missing workspaces visible but rejects their import", () => {
    const db = makeTestDb();
    const workspace = tempDir("mono-workspace");
    const missingWorkspace = join(workspace, "removed-legacy-workspace");
    const compatible = monoDescriptor(workspace);
    const legacy = monoDescriptor(missingWorkspace, {
      bridgeVersion: 0,
      protocolVersion: 0,
      installedVersion: "unknown",
      sourceId: "legacy-agent",
      label: "Legacy Agent",
      health: "stale",
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

  it("updates identity while keeping generic configuration policy empty", () => {
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
        configPolicy: {},
        probeTimeoutMs: 45_000,
      },
    });
    expect(updated).toMatchObject({
      probeTimeoutMs: 45_000,
      configPolicy: {},
      agent: { displayName: "New Name", enabled: false, sdk: "acp", executionMode: "acp" },
    });
    expect(updated.agent.model).toBe(`acp:${profile.id}`);
    expect(() => updateAcpProfileRecord({
      db,
      id: profile.id,
      input: { configPolicy: { endpoint: "not-supported" } },
    })).toThrow(/configPolicy is reserved and must be an empty object/i);
    expect(getAcpProfile({ db, id: profile.id }).configPolicy).toEqual({});
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
    const workspaceLink = join(base, "workspace-link");
    symlinkSync(workspace, workspaceLink);
    const profile = createAcpProfile({
      db,
      input: { sourceId: "personal-agent" },
      mono: { descriptor: monoDescriptor(workspaceLink), command: process.execPath },
    });
    expect(profile.canonicalWorkspace).toBe(realpathSync(workspace));
    expect(profile.monoSource.workspace.path).toBe(realpathSync(workspace));

    expect(() => createAcpProfile({
      db,
      input: { sourceId: "legacy-agent" },
      mono: {
        descriptor: monoDescriptor(workspace, { sourceId: "legacy-agent", compatible: false }),
        command: process.execPath,
      },
    })).toThrow(/not ACP-compatible/i);
  });
});
