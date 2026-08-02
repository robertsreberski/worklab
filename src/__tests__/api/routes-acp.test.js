import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMcpToken } from "../../core/service-token.js";
import { newAcpInteractionId } from "../../core/ids.js";
import {
  claimAcpInteractionResponse,
  finalizeAcpInteractionResponse,
  insertAcpInteractionRequest,
} from "../../core/db/queries/acp-interactions.js";
import { makeTestServer } from "../helpers/test-server.js";

const cleanup = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "worklab-acp-api-"));
  cleanup.push(directory);
  return directory;
}

function monoDescriptor(cwd, overrides = {}) {
  return {
    schema: "mono-agent.acp-source.v1",
    bridgeVersion: 1,
    protocolVersion: 1,
    installedVersion: "1.2.3",
    sourceId: "mono-primary",
    label: "Mono Primary",
    health: "running",
    compatible: true,
    workspace: { path: cwd, owner: "agent" },
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

async function createGeneric(agent, cwd, body = {}) {
  return agent.post("/api/acp/profiles").send({
    agentName: "external",
    displayName: "External",
    command: process.execPath,
    cwd,
    envKeys: ["ACP_API_TOKEN"],
    ...body,
  });
}

describe("ACP API", () => {
  it("rejects cross-site mutations before any ACP process or task can launch", async () => {
    vi.stubEnv("WORKLAB_ACP_ALLOWED_ORIGINS", "https://split-ui.example");
    const cwd = workspace();
    const dataDir = workspace();
    const probe = vi.fn(async () => ({ status: "ready" }));
    const discoverMono = vi.fn(async () => ({
      schema: "mono-agent.acp-discovery.v1",
      bridgeVersion: 1,
      protocolVersion: 1,
      sources: [],
    }));
    const { agent, rawAgent, db, watcher } = makeTestServer({
      dataDir,
      acpControls: { discoverMono, probe },
    });
    const maybeAutoStart = vi.spyOn(watcher, "maybeAutoStart");
    const handleRunRequested = vi.spyOn(watcher, "handleRunRequested");
    const profileBody = {
      agentName: "cross-site-process",
      displayName: "Cross-site process",
      command: "/bin/sh",
      args: ["-c", "touch should-never-run"],
      cwd,
    };

    await rawAgent.post("/api/acp/profiles")
      .set("origin", "https://evil.example")
      .set("sec-fetch-site", "cross-site")
      .send(profileBody)
      .expect(403);
    await rawAgent.post("/api/acp/profiles")
      .set("host", "evil.example")
      .set("origin", "http://evil.example")
      .set("sec-fetch-site", "same-origin")
      .send(profileBody)
      .expect(403);
    await rawAgent.post("/api/acp/profiles")
      .set("host", "127.0.0.1:7878")
      .set("origin", "http://localhost:9999")
      .set("sec-fetch-site", "same-site")
      .send(profileBody)
      .expect(403);
    await rawAgent.post("/api/acp/profiles")
      .set("host", "worklab.example.ts.net")
      .set("sec-fetch-site", "same-origin")
      .send(profileBody)
      .expect(401);
    await rawAgent.post("/api/acp/profiles").send(profileBody).expect(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM acp_profiles").get().count).toBe(0);

    await rawAgent.post("/api/acp/profiles")
      .set("host", "127.0.0.1:7878")
      .set("origin", "https://split-ui.example")
      .set("sec-fetch-site", "cross-site")
      .send({
        ...profileBody,
        agentName: "configured-origin",
        displayName: "Configured origin",
      })
      .expect("access-control-allow-origin", "https://split-ui.example")
      .expect(201);

    const preflight = await rawAgent.options("/api/acp/profiles")
      .set("host", "127.0.0.1:7878")
      .set("origin", "https://split-ui.example")
      .set("access-control-request-method", "POST")
      .set("access-control-request-headers", "authorization, content-type")
      .expect(204);
    expect(preflight.headers).toMatchObject({
      "access-control-allow-origin": "https://split-ui.example",
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, Last-Event-ID, X-Attachment-Filename, X-Skill-Filename",
      "access-control-max-age": "600",
    });
    expect(preflight.headers.vary).toMatch(/Origin/u);

    const rejectedPreflight = await rawAgent.options("/api/acp/profiles")
      .set("host", "127.0.0.1:7878")
      .set("origin", "https://evil.example")
      .set("access-control-request-method", "POST")
      .expect(403);
    expect(rejectedPreflight.headers).not.toHaveProperty("access-control-allow-origin");

    const created = await agent.post("/api/acp/profiles").send({
      ...profileBody,
      agentName: "approved-process",
      displayName: "Approved process",
    }).expect(201);
    await rawAgent.post(`/api/acp/profiles/${created.body.profile.id}/probe`)
      .set("origin", "https://evil.example")
      .set("sec-fetch-site", "cross-site")
      .send({})
      .expect(403);
    expect(probe).not.toHaveBeenCalled();

    await rawAgent.post(`/api/acp/profiles/${created.body.profile.id}/probe`)
      .set("authorization", `Bearer ${readMcpToken(dataDir)}`)
      .send({})
      .expect(202);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

    await rawAgent.post("/api/tasks")
      .set("origin", "https://evil.example")
      .set("sec-fetch-site", "cross-site")
      .send({
        title: "hostile auto-run",
        instructions: "run attacker instructions",
        owner_agent: "approved-process",
        stage: "execute",
      })
      .expect(403);
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(maybeAutoStart).not.toHaveBeenCalled();

    const task = (await agent.post("/api/tasks").send({
      title: "existing ACP task",
      owner_agent: "approved-process",
      stage: "execute",
      run_policy: "manual",
    }).expect(201)).body.task;
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    maybeAutoStart.mockClear();
    handleRunRequested.mockClear();
    await rawAgent.post(`/api/tasks/${task.id}/run`)
      .set("origin", "https://evil.example")
      .set("sec-fetch-site", "cross-site")
      .send({})
      .expect(403);
    expect(handleRunRequested).not.toHaveBeenCalled();

    const crossOriginRead = await rawAgent.get("/api/agents")
      .set("origin", "https://evil.example")
      .expect(200);
    expect(crossOriginRead.headers).not.toHaveProperty("access-control-allow-origin");

    await rawAgent.get("/api/agents")
      .set("host", "127.0.0.1:7878")
      .set("origin", "https://split-ui.example")
      .expect("access-control-allow-origin", "https://split-ui.example")
      .expect(200);

    for (const path of [
      "/api/acp/discovery/mono",
      "/api/acp/discovery/mono/",
      "/api/acp/discovery/MONO",
      "/api/acp/discovery/MONO/",
    ]) {
      await rawAgent.get(path)
        .set("origin", "https://evil.example")
        .set("sec-fetch-site", "cross-site")
        .expect(403);
      await rawAgent.head(path)
        .set("origin", "https://evil.example")
        .set("sec-fetch-site", "cross-site")
        .expect(403);
    }
    expect(discoverMono).not.toHaveBeenCalled();

    await agent.get("/api/acp/discovery/mono").expect(200);
    expect(discoverMono).toHaveBeenCalledTimes(1);
  });

  it("returns canonical mono discovery and imports a sourceId-only profile", async () => {
    const cwd = workspace();
    const descriptor = monoDescriptor(cwd, { ignoredToken: "do-not-expose" });
    const discoverMono = vi.fn(async () => ({
      schema: "mono-agent.acp-discovery.v1",
      bridgeVersion: 1,
      protocolVersion: 1,
      sources: [descriptor],
      accessToken: "discovery-secret",
    }));
    const resolveMonoSource = vi.fn(async ({ sourceId }) => ({
      descriptor: { ...descriptor, sourceId },
      command: process.execPath,
      args: ["bridge"],
      envKeys: ["MONO_AGENT_TOKEN"],
      env: { MONO_AGENT_TOKEN: "resolved-secret" },
    }));
    const { agent, db } = makeTestServer({ acpControls: { discoverMono, resolveMonoSource } });

    const discoveryResponse = await agent.get("/api/acp/discovery/mono").expect(200);
    expect(discoveryResponse.body.discovery).toMatchObject({
      schema: "mono-agent.acp-discovery.v1",
      sources: [{
        sourceId: "mono-primary",
        imported: false,
        constraints: { promptContent: ["text", "resource_link"] },
      }],
    });
    expect(JSON.stringify(discoveryResponse.body)).not.toMatch(/discovery-secret|do-not-expose/u);
    expect(discoverMono).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal),
      timeoutMs: 30_000,
    }));

    const created = await agent.post("/api/acp/profiles")
      .send({ sourceId: "mono-primary" })
      .expect(201);
    expect(created.body.profile).toMatchObject({
      driver: "mono",
      monoSourceId: "mono-primary",
      envKeys: ["MONO_AGENT_TOKEN"],
      configurationOwner: "agent",
      workspaceOwner: "agent",
      mcpOwner: "agent",
      permissionsPolicy: { filesystem: false, terminal: false, network: false, mcp: false },
      agent: {
        agentName: "mono-primary",
        sdk: "acp",
        executionMode: "acp",
      },
    });
    expect(created.body.profile.agent.model).toBe(`acp:${created.body.profile.id}`);
    expect(resolveMonoSource).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "mono-primary",
      signal: expect.any(AbortSignal),
      timeoutMs: 30_000,
    }));
    expect(JSON.stringify(db.prepare("SELECT * FROM acp_profiles").all()))
      .not.toContain("resolved-secret");

    const linkedDiscovery = await agent.get("/api/acp/discovery/mono").expect(200);
    expect(linkedDiscovery.body.discovery.sources[0]).toMatchObject({
      sourceId: "mono-primary",
      imported: true,
      binding: {
        profileId: created.body.profile.id,
        agentName: "mono-primary",
        displayName: "Mono Primary",
        enabled: true,
      },
    });
    expect(linkedDiscovery.body.discovery.sources[0].binding).toEqual({
      profileId: created.body.profile.id,
      agentName: "mono-primary",
      displayName: "Mono Primary",
      enabled: true,
    });
    expect(linkedDiscovery.body.discovery.sources[0].binding).not.toHaveProperty("command");
    expect(linkedDiscovery.body.discovery.sources[0].binding).not.toHaveProperty("envKeys");
  });

  it("accepts only sourceId in mono profile import requests", async () => {
    const cwd = workspace();
    const resolveMonoSource = vi.fn(async () => ({
      descriptor: monoDescriptor(cwd),
      command: process.execPath,
      args: [],
      envKeys: [],
    }));
    const { agent } = makeTestServer({ acpControls: { resolveMonoSource } });

    const response = await agent.post("/api/acp/profiles").send({
      sourceId: "mono-primary",
      displayName: "Caller Override",
    }).expect(400);
    expect(response.body).toEqual({
      error: {
        code: "validation",
        message: "mono profile imports accept exactly one field: sourceId",
      },
    });
    expect(resolveMonoSource).not.toHaveBeenCalled();

    await agent.post("/api/acp/profiles").send({
      source_id: "mono-primary",
    }).expect(400);
    expect(resolveMonoSource).not.toHaveBeenCalled();
  });

  it("keeps mono session/config fields descriptor-owned on PATCH", async () => {
    const cwd = workspace();
    const resolveMonoSource = vi.fn(async () => ({
      descriptor: monoDescriptor(cwd),
      command: process.execPath,
      args: [],
      envKeys: [],
    }));
    const { agent } = makeTestServer({ acpControls: { resolveMonoSource } });
    const profile = (await agent.post("/api/acp/profiles")
      .send({ sourceId: "mono-primary" })
      .expect(201)).body.profile;

    for (const body of [
      { sessionPolicy: {} },
      { session_policy: {} },
      { probeTimeoutMs: 30_000 },
      { probe_timeout_ms: 30_000 },
    ]) {
      const response = await agent.patch(`/api/acp/profiles/${profile.id}`).send(body).expect(400);
      expect(response.body.error.message).toMatch(/fixed by the mono source descriptor/i);
    }

    const metadata = await agent.patch(`/api/acp/profiles/${profile.id}`).send({
      displayName: "Local Label",
      description: "Local description",
      enabled: false,
    }).expect(200);
    expect(metadata.body.profile.agent).toMatchObject({
      displayName: "Local Label",
      description: "Local description",
      enabled: false,
    });
  });

  it("requires generic profiles to be recreated before launch identity changes", async () => {
    const cwd = workspace();
    const { agent } = makeTestServer();
    const profile = (await createGeneric(agent, cwd)).body.profile;

    const rejected = await agent.patch(`/api/acp/profiles/${profile.id}`)
      .send({ args: ["different-agent.js"] })
      .expect(409);
    expect(rejected.body).toEqual({
      error: {
        code: "profile_identity_immutable",
        message: "ACP launch and session identity is immutable; create a new profile to change args",
      },
    });

    const updated = await agent.patch(`/api/acp/profiles/${profile.id}`)
      .send({ displayName: "Renamed", probeTimeoutMs: 45_000 })
      .expect(200);
    expect(updated.body.profile).toMatchObject({
      args: [],
      probeTimeoutMs: 45_000,
      agent: { displayName: "Renamed" },
    });
  });

  it("does not expose errors returned by injected discovery controls", async () => {
    const { agent } = makeTestServer({
      acpControls: {
        discoverMono: async () => {
          throw Object.assign(new Error("failed with token discovery-control-secret"), {
            code: "upstream_error",
            status: 401,
          });
        },
      },
    });
    const response = await agent.get("/api/acp/discovery/mono").expect(502);
    expect(response.body).toEqual({
      error: { code: "discovery_failed", message: "mono-agent ACP discovery failed" },
    });
    expect(JSON.stringify(response.body)).not.toContain("discovery-control-secret");
  });

  it("serves camelCase generic profiles and rejects secret-bearing profile input", async () => {
    const cwd = workspace();
    const { agent } = makeTestServer();
    const created = await createGeneric(agent, cwd);
    expect(created.status).toBe(201);
    expect(created.body.profile).toMatchObject({
      agentName: "external",
      envKeys: ["ACP_API_TOKEN"],
      probeTimeoutMs: 30_000,
      permissionsPolicy: { filesystem: false, terminal: false, network: false, mcp: false },
    });

    const list = await agent.get("/api/acp/profiles").expect(200);
    expect(list.body.profiles).toHaveLength(1);
    expect(list.body.profiles[0]).not.toHaveProperty("agent_name");

    const rejected = await createGeneric(agent, cwd, {
      agentName: "unsafe",
      env: { ACP_API_TOKEN: "must-not-persist" },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("validation");
    expect(JSON.stringify(rejected.body)).not.toContain("must-not-persist");
  });

  it("rejects unsupported ACP client capability policies on create and PATCH", async () => {
    const cwd = workspace();
    const { agent } = makeTestServer();
    const createResponse = await createGeneric(agent, cwd, {
      permissionsPolicy: { filesystem: true, terminal: false, network: false, mcp: false },
    });
    expect(createResponse.status).toBe(400);
    expect(createResponse.body.error).toMatchObject({ code: "capability_unsupported" });

    const profile = (await createGeneric(agent, cwd)).body.profile;
    const patchResponse = await agent.patch(`/api/acp/profiles/${profile.id}`).send({
      permissionsPolicy: { filesystem: false, terminal: true, network: false, mcp: false },
    }).expect(400);
    expect(patchResponse.body.error).toMatchObject({ code: "capability_unsupported" });

    const networkResponse = await agent.patch(`/api/acp/profiles/${profile.id}`).send({
      permissionsPolicy: { filesystem: false, terminal: false, network: true, mcp: false },
    }).expect(400);
    expect(networkResponse.body.error).toMatchObject({ code: "capability_unsupported" });
  });

  it("starts control operations with 202 and exposes sanitized operation state", async () => {
    const cwd = workspace();
    const rawSessionIds = ["session/one", "session/two"];
    const rawPageCursor = "opaque/page-2?state=keep+exact==";
    let pageCursor;
    const listedContexts = [];
    let deletedSession;
    const controls = {
      probe: async () => ({
        ok: true,
        status: "ready",
        apiKey: "probe-secret",
        authMethods: [{
          id: "browser-login",
          name: "Browser login",
          type: "agent",
          accessToken: "method-secret",
        }],
      }),
      listSessions: async ({ profile: activeProfile, cursor }) => {
        listedContexts.push({ cursor, cwd: activeProfile.cwd });
        const page = cursor ? 1 : 0;
        const rawSessionId = rawSessionIds[page];
        return {
          sessions: [{
            sessionId: rawSessionId,
            providerSessionId: `acp:v1:${activeProfile.id}:${Buffer.from(rawSessionId).toString("base64url")}`,
            title: page === 0 ? "Listed session 1" : rawSessionId,
            updatedAt: rawSessionId,
          }],
          ...(cursor ? {} : { nextCursor: pageCursor }),
        };
      },
      deleteSession: async ({ providerSessionId }) => {
        deletedSession = providerSessionId;
        return {
          deleted: true,
          providerSessionId,
          sessionId: rawSessionIds[1],
          token: "delete-secret",
        };
      },
    };
    const { agent, db, acpOperationManager } = makeTestServer({ acpControls: controls });
    const profile = (await createGeneric(agent, cwd)).body.profile;
    pageCursor = `acp-cursor:v1:${profile.id}:${Buffer.from(rawPageCursor).toString("base64url")}`;

    const started = await agent.post(`/api/acp/profiles/${profile.id}/probe`).expect(202);
    expect(started.body.operation.state).toBe("queued");
    await vi.waitFor(() => {
      expect(acpOperationManager.get(started.body.operation.id)?.state).toBe("succeeded");
    });
    const fetched = await agent.get(`/api/acp/operations/${started.body.operation.id}`).expect(200);
    expect(fetched.body.operation.result).toEqual({
      ok: true,
      status: "ready",
      authMethods: [{ id: "browser-login", name: "Browser login", type: "agent" }],
    });
    expect(JSON.stringify(fetched.body)).not.toMatch(/probe-secret|method-secret/u);
    const probedProfile = await agent.get(`/api/acp/profiles/${profile.id}`).expect(200);
    expect(probedProfile.body.profile.lastProbe.result.authMethods).toEqual([
      { id: "browser-login", name: "Browser login", type: "agent" },
    ]);
    expect(JSON.stringify(probedProfile.body)).not.toMatch(/probe-secret|method-secret/u);

    const listed = await agent.post(`/api/acp/profiles/${profile.id}/sessions:list`).send({}).expect(202);
    await vi.waitFor(() => {
      expect(acpOperationManager.get(listed.body.operation.id)?.state).toBe("succeeded");
    });
    const listedResult = acpOperationManager.get(listed.body.operation.id).result;
    const firstPublicId = `acp:v1:${profile.id}:${Buffer.from(rawSessionIds[0]).toString("base64url")}`;
    expect(listedResult).toEqual({
      sessions: [{ id: firstPublicId, title: "Listed session 1" }],
      nextCursor: pageCursor,
      truncated: true,
    });
    expect(JSON.stringify(listedResult)).not.toContain(rawSessionIds[0]);

    const secondPage = await agent.post(`/api/acp/profiles/${profile.id}/sessions:list`)
      .send({ cursor: listedResult.nextCursor })
      .expect(202);
    expect(secondPage.body.operation.request).toEqual({ cursor: pageCursor });
    await vi.waitFor(() => {
      expect(acpOperationManager.get(secondPage.body.operation.id)?.state).toBe("succeeded");
    });
    const secondResult = acpOperationManager.get(secondPage.body.operation.id).result;
    const publicId = `acp:v1:${profile.id}:${Buffer.from(rawSessionIds[1]).toString("base64url")}`;
    expect(secondResult).toEqual({
      sessions: [{ id: publicId }],
      truncated: false,
    });
    expect(listedContexts).toEqual([
      { cursor: null, cwd: profile.cwd },
      { cursor: pageCursor, cwd: profile.cwd },
    ]);
    expect(JSON.stringify(secondResult)).not.toContain(rawSessionIds[1]);

    const clientCwd = await agent.post(`/api/acp/profiles/${profile.id}/sessions:list`).send({
      cursor: pageCursor,
      cwd: "/client/must-not-select-workspace",
    }).expect(400);
    expect(clientCwd.body.error).toEqual({
      code: "validation",
      message: "sessions:list accepts only one optional field: cursor",
    });
    const oversizedCursor = await agent.post(`/api/acp/profiles/${profile.id}/sessions:list`)
      .send({ cursor: "x".repeat(5_601) })
      .expect(400);
    expect(oversizedCursor.body.error).toEqual({ code: "validation", message: "cursor is invalid" });
    expect(listedContexts).toHaveLength(2);

    const deleted = await agent.delete(
      `/api/acp/profiles/${profile.id}/sessions/${encodeURIComponent(secondResult.sessions[0].id)}`,
    ).expect(202);
    await vi.waitFor(() => {
      expect(acpOperationManager.get(deleted.body.operation.id)?.state).toBe("succeeded");
    });
    expect(deletedSession).toBe(publicId);
    const deleteResult = acpOperationManager.get(deleted.body.operation.id);
    expect(deleteResult.request).toEqual({ providerSessionId: publicId });
    expect(deleteResult.result).toEqual({ deleted: true, id: publicId });
    expect(JSON.stringify(deleteResult)).not.toMatch(/delete-secret|session\/(?:one|two)/u);
    expect(JSON.stringify(db.prepare("SELECT * FROM acp_operations ORDER BY created_at").all()))
      .not.toMatch(/delete-secret|session\/(?:one|two)/u);
  });

  it("sanitizes legacy ACP operation and interaction rows on every API read", async () => {
    const cwd = workspace();
    const { agent, db } = makeTestServer();
    const profile = (await createGeneric(agent, cwd)).body.profile;
    const rawSessionId = "RAW_LEGACY_API_SESSION";
    const providerSessionId = `acp:v1:${profile.id}:${Buffer.from(rawSessionId).toString("base64url")}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO acp_operations (
        id, profile_id, kind, state, remote_session_id, request_json,
        result_json, error_json, created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, 'list_sessions', 'failed', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "acpo_legacy_api",
      profile.id,
      rawSessionId,
      JSON.stringify({ cursor: rawSessionId, sessionId: rawSessionId }),
      JSON.stringify({
        sessions: [{
          sessionId: rawSessionId,
          providerSessionId,
          title: `Legacy ${rawSessionId}`,
        }],
        nextCursor: `cursor:${rawSessionId}`,
      }),
      JSON.stringify({ code: "protocol", safeMessage: `Failure ${rawSessionId}` }),
      now,
      now,
      now,
      now,
    );
    db.prepare(`
      INSERT INTO acp_interactions (
        id, profile_id, task_run_id, operation_id, protocol_request_id,
        kind, request_schema_json, state, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, 'form', ?, 'pending', ?, ?)
    `).run(
      "acpi_legacy_api",
      profile.id,
      "acpo_legacy_api",
      `request:${rawSessionId}`,
      JSON.stringify({
        sessionId: rawSessionId,
        title: `Legacy form ${rawSessionId}`,
      }),
      now,
      now,
    );

    const operation = await agent.get("/api/acp/operations/acpo_legacy_api").expect(200);
    const operations = await agent.get(`/api/acp/profiles/${profile.id}/operations`).expect(200);
    const interactions = await agent.get("/api/acp/operations/acpo_legacy_api/interactions").expect(200);
    const pending = await agent.get("/api/acp/interactions?state=pending").expect(200);
    const responses = { operation: operation.body, operations: operations.body, interactions: interactions.body, pending: pending.body };

    expect(operation.body.operation).toMatchObject({
      remoteSessionId: null,
      request: {},
      result: {
        sessions: [{ id: providerSessionId, title: "Legacy [redacted]" }],
        truncated: true,
      },
      error: { code: "protocol", message: "ACP list_sessions operation failed." },
    });
    expect(interactions.body.interactions[0]).toMatchObject({
      protocolRequestId: expect.stringMatching(/^acp-request:v1:/u),
      requestSchema: { title: "Legacy form [redacted]" },
    });
    expect(JSON.stringify(responses)).not.toContain(rawSessionId);
  });

  it("responds to operation interactions without persisting or echoing form answers", async () => {
    const cwd = workspace();
    const rawSessionId = "RAW_REMOTE_OPERATION_SESSION_DO_NOT_PERSIST";
    let delivered;
    let selectedMethod;
    const controls = {
      authenticate: async ({ authMethodId, onInteraction }) => {
        selectedMethod = authMethodId;
        delivered = await onInteraction({
          requestId: "login-form",
          kind: "form",
          schema: {
            sessionId: rawSessionId,
            title: "Login",
            properties: { password: { type: "string", default: "schema-secret" } },
          },
        });
        return { authenticated: true };
      },
    };
    const { agent, db, acpOperationManager } = makeTestServer({ acpControls: controls });
    const profile = (await createGeneric(agent, cwd)).body.profile;
    const operation = (await agent.post(`/api/acp/profiles/${profile.id}/authenticate`)
      .send({ authMethodId: "browser-login" })
      .expect(202)).body.operation;
    expect(operation.request).toEqual({ authMethodId: "browser-login" });
    let interaction;
    await vi.waitFor(async () => {
      const result = await agent.get(`/api/acp/operations/${operation.id}/interactions`).expect(200);
      [interaction] = result.body.interactions;
      expect(interaction?.state).toBe("pending");
    });

    const response = await agent.post(`/api/acp/interactions/${interaction.id}/respond`).send({
      disposition: "accept",
      values: { password: "actual-form-secret" },
    }).expect(200);
    expect(response.body.interaction).toMatchObject({ state: "submitted", disposition: "accept" });
    expect(JSON.stringify(response.body)).not.toContain("actual-form-secret");
    await vi.waitFor(() => {
      expect(acpOperationManager.get(operation.id)?.state).toBe("succeeded");
    });
    expect(delivered.values.password).toBe("actual-form-secret");
    expect(selectedMethod).toBe("browser-login");
    expect(JSON.stringify({
      profiles: db.prepare("SELECT * FROM acp_profiles").all(),
      operations: db.prepare("SELECT * FROM acp_operations").all(),
      interactions: db.prepare("SELECT * FROM acp_interactions").all(),
    })).not.toMatch(/actual-form-secret|schema-secret|RAW_REMOTE_OPERATION_SESSION/u);
  });

  it("returns 400 and keeps management permissions pending for unoffered options", async () => {
    const cwd = workspace();
    let delivered;
    const controls = {
      authenticate: async ({ onInteraction }) => {
        delivered = await onInteraction({
          requestId: "permission-echo-api",
          kind: "permission",
          schema: {
            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
          },
        });
        return { authenticated: true };
      },
    };
    const { agent, db } = makeTestServer({ acpControls: controls });
    const profile = (await createGeneric(agent, cwd)).body.profile;
    const operation = (await agent.post(`/api/acp/profiles/${profile.id}/authenticate`)
      .send({ authMethodId: "permission-login" })
      .expect(202)).body.operation;
    let interaction;
    await vi.waitFor(() => {
      interaction = db.prepare("SELECT * FROM acp_interactions WHERE operation_id = ?").get(operation.id);
      expect(interaction?.state).toBe("pending");
    });

    await agent.post(`/api/acp/interactions/${interaction.id}/respond`).send({
      disposition: "selected",
      outcome: { outcome: "selected", optionId: "hidden-admin-choice" },
    }).expect(400, {
      error: { code: "validation", message: "permission response must select an offered option" },
    });
    expect(db.prepare("SELECT state FROM acp_interactions WHERE id = ?").get(interaction.id).state)
      .toBe("pending");
    expect(delivered).toBeUndefined();

    await agent.post(`/api/acp/interactions/${interaction.id}/respond`).send({
      disposition: "cancel",
      outcome: { outcome: "selected", optionId: "allow-once" },
    }).expect(400, {
      error: { code: "validation", message: "cancelled permission responses cannot select an option" },
    });
    expect(db.prepare("SELECT state FROM acp_interactions WHERE id = ?").get(interaction.id).state)
      .toBe("pending");

    await agent.post(`/api/acp/interactions/${interaction.id}/respond`).send({
      disposition: "selected",
      outcome: { outcome: "selected", optionId: "allow-once" },
    }).expect(200);
  });

  it("cancels only active management operations", async () => {
    const cwd = workspace();
    const probe = vi.fn(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const { agent, acpOperationManager } = makeTestServer({ acpControls: { probe } });
    const profile = (await createGeneric(agent, cwd)).body.profile;
    const operation = (await agent.post(`/api/acp/profiles/${profile.id}/probe`)
      .expect(202)).body.operation;

    const cancelled = await agent.post(`/api/acp/operations/${operation.id}/cancel`)
      .send({})
      .expect(202);
    expect(cancelled.body).toMatchObject({ cancellationRequested: true });
    await vi.waitFor(() => {
      expect(acpOperationManager.get(operation.id)?.state).toBe("cancelled");
    });
    await agent.post(`/api/acp/operations/${operation.id}/cancel`)
      .send({})
      .expect(409, {
        error: { code: "not_active", message: "ACP operation is not active" },
      });
    await agent.post("/api/acp/operations/acpo_missing/cancel")
      .send({})
      .expect(404, {
        error: { code: "not_found", message: "ACP operation not found" },
      });
  });

  it("requires exactly one bounded authMethodId for authentication", async () => {
    const cwd = workspace();
    const authenticate = vi.fn(async () => ({ authenticated: true }));
    const { agent } = makeTestServer({ acpControls: { authenticate } });
    const profile = (await createGeneric(agent, cwd)).body.profile;

    await agent.post(`/api/acp/profiles/${profile.id}/authenticate`)
      .send({})
      .expect(400, {
        error: { code: "validation", message: "authenticate accepts exactly one field: authMethodId" },
      });
    await agent.post(`/api/acp/profiles/${profile.id}/authenticate`)
      .send({ authMethodId: "browser-login", chooseFirst: true })
      .expect(400);
    await agent.post(`/api/acp/profiles/${profile.id}/authenticate`)
      .send({ authMethodId: "x".repeat(501) })
      .expect(400, {
        error: { code: "validation", message: "authMethodId is invalid" },
      });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("injects task-run interaction responses through the watcher without route-level value persistence", async () => {
    const cwd = workspace();
    let server;
    const sendRunAcpInteractionResponse = vi.fn(async ({ interactionId, disposition }) => {
      claimAcpInteractionResponse(server.db, interactionId, { disposition });
      finalizeAcpInteractionResponse(server.db, interactionId);
    });
    server = makeTestServer({
      watcher: {
        handleRunRequested: async () => ({ runId: "fake-run" }),
        sendRunAcpInteractionResponse,
      },
    });
    const profile = (await createGeneric(server.agent, cwd)).body.profile;
    server.db.prepare(`
      INSERT INTO task_runs (id, mode, stage, agent_name, status, process_status, started_at)
      VALUES ('run-acp-one', 'execute', 'execute', ?, 'running', 'running', ?)
    `).run(profile.agentName, Date.now());
    const interactionId = newAcpInteractionId();
    insertAcpInteractionRequest(server.db, {
      id: interactionId,
      profileId: profile.id,
      taskRunId: "run-acp-one",
      operationId: null,
      protocolRequestId: "task-form-one",
      kind: "form",
      requestSchemaJson: JSON.stringify({ properties: { password: { type: "string" } } }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const response = await server.agent.post(`/api/acp/interactions/${interactionId}/respond`).send({
      disposition: "accept",
      values: { password: "watcher-only-secret" },
    }).expect(200);
    expect(sendRunAcpInteractionResponse).toHaveBeenCalledWith({
      runId: "run-acp-one",
      interactionId,
      response: {
        disposition: "accept",
        values: { password: "watcher-only-secret" },
      },
      disposition: "accept",
    });
    expect(response.body.interaction).toMatchObject({ state: "submitted", disposition: "accept" });
    expect(JSON.stringify(response.body)).not.toContain("watcher-only-secret");
    expect(JSON.stringify(server.db.prepare("SELECT * FROM acp_interactions").all()))
      .not.toContain("watcher-only-secret");
  });

  it("does not expose watcher delivery errors or submitted form values", async () => {
    const cwd = workspace();
    const watcher = {
      handleRunRequested: async () => ({ runId: "fake-run" }),
      sendRunAcpInteractionResponse: async () => {
        throw new Error("delivery failed for watcher-error-secret");
      },
    };
    const server = makeTestServer({ watcher });
    const profile = (await createGeneric(server.agent, cwd)).body.profile;
    server.db.prepare(`
      INSERT INTO task_runs (id, mode, stage, agent_name, status, process_status, started_at)
      VALUES ('run-acp-error', 'execute', 'execute', ?, 'running', 'running', ?)
    `).run(profile.agentName, Date.now());
    const interactionId = newAcpInteractionId();
    insertAcpInteractionRequest(server.db, {
      id: interactionId,
      profileId: profile.id,
      taskRunId: "run-acp-error",
      operationId: null,
      protocolRequestId: "task-form-error",
      kind: "form",
      requestSchemaJson: "{}",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const response = await server.agent.post(`/api/acp/interactions/${interactionId}/respond`).send({
      disposition: "accept",
      values: { password: "request-form-secret" },
    }).expect(502);
    expect(response.body).toEqual({
      error: {
        code: "interaction_delivery_failed",
        message: "task-run ACP interaction response failed",
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/watcher-error-secret|request-form-secret/u);
    expect(server.db.prepare("SELECT state FROM acp_interactions WHERE id = ?").get(interactionId).state)
      .toBe("pending");
  });

  it("honors a failed watcher delivery result and leaves the interaction retryable", async () => {
    const cwd = workspace();
    const server = makeTestServer({
      watcher: {
        handleRunRequested: async () => ({ runId: "fake-run" }),
        sendRunAcpInteractionResponse: async () => ({
          ok: false,
          code: "delivery_failed",
          message: "stdin failed with dispatcher-secret",
        }),
        sendRunAcpInteractionCancel: async () => ({
          ok: false,
          code: "delivery_failed",
          message: "stdin cancel failed with dispatcher-secret",
        }),
      },
    });
    const profile = (await createGeneric(server.agent, cwd)).body.profile;
    server.db.prepare(`
      INSERT INTO task_runs (id, mode, stage, agent_name, status, process_status, started_at)
      VALUES ('run-acp-result-error', 'execute', 'execute', ?, 'running', 'running', ?)
    `).run(profile.agentName, Date.now());
    const interactionId = newAcpInteractionId();
    insertAcpInteractionRequest(server.db, {
      id: interactionId,
      profileId: profile.id,
      taskRunId: "run-acp-result-error",
      protocolRequestId: "task-form-result-error",
      kind: "form",
      requestSchemaJson: "{}",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const response = await server.agent.post(`/api/acp/interactions/${interactionId}/respond`).send({
      disposition: "accept",
      values: { password: "request-dispatcher-secret" },
    }).expect(503);
    expect(response.body).toEqual({
      error: {
        code: "delivery_failed",
        message: "task-run ACP interaction response failed",
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/dispatcher-secret|request-dispatcher-secret/u);
    expect(server.db.prepare("SELECT state FROM acp_interactions WHERE id = ?").get(interactionId).state)
      .toBe("pending");

    const cancelId = newAcpInteractionId();
    insertAcpInteractionRequest(server.db, {
      id: cancelId,
      profileId: profile.id,
      taskRunId: "run-acp-result-error",
      protocolRequestId: "task-form-cancel-error",
      kind: "form",
      requestSchemaJson: "{}",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await server.agent.post(`/api/acp/interactions/${cancelId}/cancel`)
      .send({})
      .expect(503, {
        error: {
          code: "delivery_failed",
          message: "task-run ACP interaction cancellation failed",
        },
      });
    expect(server.db.prepare("SELECT state FROM acp_interactions WHERE id = ?").get(cancelId).state)
      .toBe("pending");
  });

  it("does not expose errors returned by an injected operation manager", async () => {
    const cwd = workspace();
    const { agent } = makeTestServer({
      acpOperationManager: {
        start: () => {
          throw Object.assign(new Error("operation failed with manager-control-secret"), {
            code: "secret_code_manager-control-secret",
            status: 418,
          });
        },
        isProfileActive: () => false,
      },
    });
    const profile = (await createGeneric(agent, cwd)).body.profile;
    const response = await agent.post(`/api/acp/profiles/${profile.id}/probe`).expect(400);
    expect(response.body).toEqual({
      error: { code: "validation", message: "Request failed" },
    });
    expect(JSON.stringify(response.body)).not.toContain("manager-control-secret");
  });
});
