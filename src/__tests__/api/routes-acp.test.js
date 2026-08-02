import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newAcpInteractionId } from "../../core/ids.js";
import {
  claimAcpInteractionResponse,
  finalizeAcpInteractionResponse,
  insertAcpInteractionRequest,
} from "../../core/db/queries/acp-interactions.js";
import { makeTestServer } from "../helpers/test-server.js";

const cleanup = [];

afterEach(() => {
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
      sources: [{ sourceId: "mono-primary", constraints: { promptContent: ["text", "resource_link"] } }],
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

  it("starts control operations with 202 and exposes sanitized operation state", async () => {
    const cwd = workspace();
    let deletedSession;
    const controls = {
      probe: async () => ({ ok: true, status: "ready", apiKey: "probe-secret" }),
      deleteSession: async ({ remoteSessionId }) => {
        deletedSession = remoteSessionId;
        return { deleted: true, sessionId: remoteSessionId, token: "delete-secret" };
      },
    };
    const { agent, acpOperationManager } = makeTestServer({ acpControls: controls });
    const profile = (await createGeneric(agent, cwd)).body.profile;

    const started = await agent.post(`/api/acp/profiles/${profile.id}/probe`).expect(202);
    expect(started.body.operation.state).toBe("queued");
    await vi.waitFor(() => {
      expect(acpOperationManager.get(started.body.operation.id)?.state).toBe("succeeded");
    });
    const fetched = await agent.get(`/api/acp/operations/${started.body.operation.id}`).expect(200);
    expect(fetched.body.operation.result).toEqual({ ok: true, status: "ready" });
    expect(JSON.stringify(fetched.body)).not.toContain("probe-secret");

    const deleted = await agent.delete(`/api/acp/profiles/${profile.id}/sessions/session%2Fone`).expect(202);
    await vi.waitFor(() => {
      expect(acpOperationManager.get(deleted.body.operation.id)?.state).toBe("succeeded");
    });
    expect(deletedSession).toBe("session/one");
    const deleteResult = acpOperationManager.get(deleted.body.operation.id);
    expect(deleteResult.result).toEqual({ deleted: true, sessionId: "session/one" });
    expect(JSON.stringify(deleteResult)).not.toContain("delete-secret");
  });

  it("responds to operation interactions without persisting or echoing form answers", async () => {
    const cwd = workspace();
    let delivered;
    const controls = {
      authenticate: async ({ onInteraction }) => {
        delivered = await onInteraction({
          requestId: "login-form",
          kind: "form",
          schema: {
            title: "Login",
            properties: { password: { type: "string", default: "schema-secret" } },
          },
        });
        return { authenticated: true };
      },
    };
    const { agent, db, acpOperationManager } = makeTestServer({ acpControls: controls });
    const profile = (await createGeneric(agent, cwd)).body.profile;
    const operation = (await agent.post(`/api/acp/profiles/${profile.id}/authenticate`).expect(202))
      .body.operation;
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
    expect(JSON.stringify({
      profiles: db.prepare("SELECT * FROM acp_profiles").all(),
      operations: db.prepare("SELECT * FROM acp_operations").all(),
      interactions: db.prepare("SELECT * FROM acp_interactions").all(),
    })).not.toMatch(/actual-form-secret|schema-secret/u);
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
});
