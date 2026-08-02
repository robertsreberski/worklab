import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorklabAcpControls } from "../../core/acp-controls.js";
import { createAcpProfile } from "../../core/acp-profiles.js";
import { makeTestDb } from "../helpers/test-db.js";
import { ACP_PRIVATE_URL_HANDOFF } from "../../core/acp-url-handoff.js";

const cleanup = [];
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const ACP_SESSION_TOKEN_KEY = Buffer.alloc(32, 0x51);

function opaqueToken(kind, profileId = PROFILE_ID, sealedBytes = 29) {
  const prefix = kind === "cursor" ? "acp-cursor:v2" : "acp:v2";
  return `${prefix}:${profileId}:${Buffer.alloc(sealedBytes, 0xa7).toString("base64url")}`;
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(agentRuntime, {
  loadAgentRuntime,
  agentOwnedWorkspace = false,
  acpSessionTokenKey = ACP_SESSION_TOKEN_KEY,
} = {}) {
  const db = makeTestDb();
  const cwd = mkdtempSync(join(tmpdir(), "worklab-acp-controls-"));
  cleanup.push(cwd);
  const canonicalWorkspace = agentOwnedWorkspace
    ? mkdtempSync(join(tmpdir(), "worklab-acp-workspace-"))
    : null;
  if (canonicalWorkspace) cleanup.push(canonicalWorkspace);
  const profile = createAcpProfile({
    db,
    id: PROFILE_ID,
    input: {
      agentName: "external",
      displayName: "External",
      command: process.execPath,
      cwd,
      envKeys: [],
      ...(agentOwnedWorkspace ? {
        workspaceOwner: "agent",
        canonicalWorkspace,
      } : {}),
    },
  });
  const controls = createWorklabAcpControls({
    db,
    env: {},
    agentRuntime,
    ...(loadAgentRuntime ? { loadAgentRuntime } : {}),
    monoDiscoveryControls: {
      discoverMono: vi.fn(),
      resolveMonoSource: vi.fn(),
    },
    urlHandoffAvailable: true,
    acpSessionTokenKey,
  });
  return { db, profile, controls };
}

describe("createWorklabAcpControls", () => {
  it("snapshots an injected session-token key before runtime operations", async () => {
    const mutableKey = Buffer.alloc(32, 0x6c);
    const expectedKey = Buffer.from(mutableKey);
    const runtime = {
      listAcpSessions: vi.fn(async (_id, _request, options) => ({
        sessions: [],
        capturedKey: Buffer.from(options.acpSessionTokenKey),
      })),
    };
    const { db, profile, controls } = setup(runtime, { acpSessionTokenKey: mutableKey });
    mutableKey.fill(0);
    try {
      await expect(controls.listSessions({ profile })).resolves.toMatchObject({
        capturedKey: expectedKey,
      });
    } finally {
      db.close();
    }
  });

  it("delegates lifecycle operations through the shared runtime profile resolver", async () => {
    const signal = new AbortController().signal;
    const runtime = {
      probeAcpProfile: vi.fn(async (id, options) => {
        await expect(options.resolveAcpProfile(id)).resolves.toMatchObject({
          command: process.execPath,
          workspaceOwner: "client",
        });
        return {
          profileId: id,
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "browser", name: "Browser", type: "agent" }],
        };
      }),
      authenticateAcpProfile: vi.fn(async (id, methodId) => ({ profileId: id, methodId, authenticated: true })),
      logoutAcpProfile: vi.fn(async (id) => ({ profileId: id, loggedOut: true })),
      listAcpSessions: vi.fn(async (id, request) => ({
        profileId: id,
        sessions: [],
        request,
        nextCursor: null,
      })),
      validateAcpProviderSessionId: vi.fn((value) => value),
      deleteAcpSession: vi.fn(async (id) => ({ profileId: PROFILE_ID, providerSessionId: id, deleted: true })),
    };
    const { db, profile, controls } = setup(runtime);
    try {
      await expect(controls.probe({ profile, signal })).resolves.toMatchObject({
        ok: true,
        status: "ready",
        capabilities: { loadSession: true },
      });
      await expect(controls.authenticate({ profile, authMethodId: "browser", signal }))
        .resolves.toMatchObject({ authenticated: true, methodId: "browser" });
      await expect(controls.logout({ profile, signal }))
        .resolves.toMatchObject({ loggedOut: true, status: "logged_out" });
      const cursor = opaqueToken("cursor");
      await expect(controls.listSessions({
        profile: { ...profile, cwd: "/client/must-not-control-cwd" },
        cursor,
        signal,
      })).resolves.toMatchObject({
        sessions: [],
        request: { cursor },
      });
      const opaque = opaqueToken("session");
      await expect(controls.deleteSession({ profile, providerSessionId: opaque, signal }))
        .resolves.toMatchObject({ deleted: true, providerSessionId: opaque });

      expect(runtime.probeAcpProfile).toHaveBeenCalledWith(
        PROFILE_ID,
        expect.objectContaining({ resolveAcpProfile: expect.any(Function), signal }),
      );
      expect(runtime.authenticateAcpProfile).toHaveBeenCalledWith(
        PROFILE_ID,
        "browser",
        expect.objectContaining({ resolveAcpProfile: expect.any(Function), signal }),
      );
      expect(runtime.listAcpSessions).toHaveBeenCalledWith(
        PROFILE_ID,
        { cursor },
        expect.objectContaining({ resolveAcpProfile: expect.any(Function), signal }),
      );
      expect(runtime.deleteAcpSession).toHaveBeenCalledWith(
        opaque,
        expect.objectContaining({ resolveAcpProfile: expect.any(Function), signal }),
      );
      expect(runtime.validateAcpProviderSessionId).toHaveBeenCalledWith(
        opaque,
        PROFILE_ID,
        ACP_SESSION_TOKEN_KEY,
      );
    } finally {
      db.close();
    }
  });

  it("filters agent-owned session lists by canonical workspace, not process cwd", async () => {
    const runtime = {
      listAcpSessions: vi.fn(async (_id, request) => ({ sessions: [], request })),
    };
    const { db, profile, controls } = setup(runtime, { agentOwnedWorkspace: true });
    try {
      expect(profile.canonicalWorkspace).not.toBe(profile.cwd);
      await expect(controls.listSessions({ profile })).resolves.toMatchObject({
        request: { cwd: profile.canonicalWorkspace },
      });
      expect(runtime.listAcpSessions).toHaveBeenCalledWith(
        PROFILE_ID,
        { cwd: profile.canonicalWorkspace },
        expect.objectContaining({ resolveAcpProfile: expect.any(Function) }),
      );
    } finally {
      db.close();
    }
  });

  it("allows list_sessions management for a disabled profile", async () => {
    const runtime = {
      listAcpSessions: vi.fn(async (_id, request) => ({ sessions: [], request })),
    };
    const { db, profile, controls } = setup(runtime);
    try {
      db.prepare("UPDATE agents SET enabled = 0 WHERE name = ?").run(profile.agentName);
      await expect(controls.listSessions({ profile })).resolves.toMatchObject({ sessions: [] });
      expect(runtime.listAcpSessions).toHaveBeenCalledWith(
        PROFILE_ID,
        {},
        expect.objectContaining({ resolveAcpProfile: expect.any(Function) }),
      );
    } finally {
      db.close();
    }
  });

  it("rejects malformed page cursors before invoking the ACP runtime", async () => {
    const runtime = { listAcpSessions: vi.fn() };
    const { db, profile, controls } = setup(runtime);
    try {
      await expect(controls.listSessions({ profile, cursor: " page-2" }))
        .rejects.toMatchObject({ code: "validation", safeMessage: "cursor is invalid" });
      await expect(controls.listSessions({ profile, cursor: "x".repeat(5_601) }))
        .rejects.toMatchObject({ code: "validation", safeMessage: "cursor is invalid" });
      expect(runtime.listAcpSessions).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("accepts long canonical runtime cursors only for their bound profile", async () => {
    const runtime = { listAcpSessions: vi.fn(async (_id, request) => ({ sessions: [], request })) };
    const { db, profile, controls } = setup(runtime);
    const cursor = opaqueToken("cursor", PROFILE_ID, 3_033);
    try {
      expect(cursor.length).toBeGreaterThan(2_000);
      await expect(controls.listSessions({ profile, cursor })).resolves.toMatchObject({
        request: { cursor },
      });
      await expect(controls.listSessions({
        profile,
        cursor: opaqueToken("cursor", "22222222-2222-4222-8222-222222222222"),
      })).rejects.toMatchObject({ code: "validation", safeMessage: "cursor is invalid" });
      await expect(controls.listSessions({
        profile,
        cursor: `acp-cursor:v2:${PROFILE_ID}:bmV4dA==`,
      })).rejects.toMatchObject({ code: "validation", safeMessage: "cursor is invalid" });
      expect(runtime.listAcpSessions).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("maps runtime permission and form requests into operation interactions", async () => {
    const delivered = [];
    const onInteraction = vi.fn(async (request) => {
      delivered.push(request);
      if (request.kind === "permission") {
        return {
          disposition: "selected",
          outcome: { outcome: "selected", optionId: "allow-once" },
        };
      }
      return { disposition: "accept", values: { code: "private-value" } };
    });
    const runtime = {
      probeAcpProfile: vi.fn(async (_id, options) => {
        const response = await options.onAcpInteractionRequest({
          kind: "permission",
          payload: {
            sessionId: "RAW_REMOTE_PERMISSION_SESSION",
            options: [{ optionId: "allow-once", name: "Allow once" }],
          },
        }, { requestId: 42 });
        expect(response).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
        return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
      }),
      authenticateAcpProfile: vi.fn(async (_id, _method, options) => {
        const response = await options.onAcpInteractionRequest({
          kind: "elicitation",
          payload: {
            sessionId: "RAW_REMOTE_FORM_SESSION",
            mode: "form",
            message: "Enter code",
            requestedSchema: { type: "object", properties: { code: { type: "string" } } },
          },
        }, { requestId: "form-1" });
        expect(response).toEqual({ action: "accept", content: { code: "private-value" } });
        return { authenticated: true };
      }),
    };
    const { db, profile, controls } = setup(runtime);
    try {
      await controls.probe({ profile, onInteraction });
      await controls.authenticate({ profile, authMethodId: "browser", onInteraction });
      expect(delivered).toEqual([
        {
          kind: "permission",
          protocolRequestId: "42",
          requestSchema: { options: [{ optionId: "allow-once", name: "Allow once" }] },
        },
        {
          kind: "form",
          protocolRequestId: "form-1",
          requestSchema: {
            mode: "form",
            message: "Enter code",
            requestedSchema: { type: "object", properties: { code: { type: "string" } } },
          },
        },
      ]);
      expect(JSON.stringify(delivered)).not.toMatch(/RAW_REMOTE_(?:PERMISSION|FORM)_SESSION/u);
    } finally {
      db.close();
    }
  });

  it("carries URL secrets only on a non-enumerable in-process handoff symbol", async () => {
    const rawUrl = "https://host-private.example/PATH_PRIVATE/authorize?state=QUERY_PRIVATE#FRAGMENT_PRIVATE";
    let delivered;
    const runtime = {
      authenticateAcpProfile: vi.fn(async (_id, _method, options) => {
        await options.onAcpInteractionRequest({
          kind: "elicitation",
          payload: {
            mode: "url",
            message: `Continue at ${rawUrl}`,
            description: "PATH_PRIVATE QUERY_PRIVATE FRAGMENT_PRIVATE USERINFO_PRIVATE",
            url: rawUrl,
          },
        }, { requestId: "url-request-1" });
        return { authenticated: true };
      }),
    };
    const { db, profile, controls } = setup(runtime);
    try {
      await controls.authenticate({
        profile,
        authMethodId: "browser",
        onInteraction: async (request) => {
          delivered = request;
          return { disposition: "decline" };
        },
      });
      expect(delivered[ACP_PRIVATE_URL_HANDOFF]).toBe(rawUrl);
      expect(Object.keys(delivered)).toEqual(["kind", "protocolRequestId", "requestSchema"]);
      expect(delivered.requestSchema).toEqual({
        mode: "url",
        message: "Continue in your browser.",
        urlAvailable: true,
      });
      expect(JSON.stringify(delivered)).not.toMatch(
        /host-private|PATH_PRIVATE|QUERY_PRIVATE|FRAGMENT_PRIVATE|USERINFO_PRIVATE/u,
      );
    } finally {
      db.close();
    }
  });

  it("rejects URL callbacks when a safe handoff channel is unavailable", async () => {
    const db = makeTestDb();
    const cwd = mkdtempSync(join(tmpdir(), "worklab-acp-controls-no-url-"));
    cleanup.push(cwd);
    const profile = createAcpProfile({
      db,
      id: PROFILE_ID,
      input: { agentName: "external", command: process.execPath, cwd, envKeys: [] },
    });
    const runtime = {
      authenticateAcpProfile: vi.fn(async (_id, _method, options) => options.onAcpInteractionRequest({
        kind: "elicitation",
        payload: { mode: "url", url: "https://example.test/private?state=secret" },
      }, { requestId: "url-no-handoff" })),
    };
    const controls = createWorklabAcpControls({
      db,
      env: {},
      agentRuntime: runtime,
      acpSessionTokenKey: ACP_SESSION_TOKEN_KEY,
    });
    try {
      await expect(controls.authenticate({
        profile,
        authMethodId: "browser",
        onInteraction: vi.fn(),
      })).rejects.toMatchObject({ code: "url_handoff_unavailable" });
    } finally {
      db.close();
    }
  });

  it("redacts runtime context session ids from interaction ids and display fields", async () => {
    const rawSessionId = "RAW_RUNTIME_CONTEXT_SESSION";
    let delivered;
    const runtime = {
      probeAcpProfile: vi.fn(async (_id, options) => {
        await options.onAcpInteractionRequest({
          kind: "permission",
          payload: {
            sessionId: rawSessionId,
            message: `Approve ${rawSessionId}`,
            options: [{ optionId: "cancel", name: `Cancel ${rawSessionId}` }],
          },
        }, {
          requestId: `request:${rawSessionId}`,
          nested: { session_id: rawSessionId },
        });
        return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
      }),
    };
    const { db, profile, controls } = setup(runtime);
    try {
      await controls.probe({
        profile,
        onInteraction: async (request) => {
          delivered = request;
          return { disposition: "cancel" };
        },
      });
      expect(delivered).toMatchObject({
        kind: "permission",
        protocolRequestId: expect.stringMatching(/^acp-request:v1:/u),
        requestSchema: {
          message: "Approve [redacted]",
          options: [{ optionId: "cancel", name: "Cancel [redacted]" }],
        },
      });
      expect(JSON.stringify(delivered)).not.toContain(rawSessionId);
    } finally {
      db.close();
    }
  });

  it("rejects opaque sessions owned by a different ACP profile before deletion", async () => {
    const runtime = {
      validateAcpProviderSessionId: vi.fn(() => {
        throw Object.assign(new Error("ACP provider session belongs to a different profile"), {
          code: "invalid_session_id",
        });
      }),
      deleteAcpSession: vi.fn(),
    };
    const { db, profile, controls } = setup(runtime);
    try {
      await expect(controls.deleteSession({
        profile,
        providerSessionId: opaqueToken("session"),
      })).rejects.toMatchObject({ code: "invalid_session_id" });
      expect(runtime.deleteAcpSession).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each([
    ["probe", (controls, profile, signal) => controls.probe({ profile, signal })],
    ["authenticate", (controls, profile, signal) => controls.authenticate({
      profile,
      authMethodId: "browser",
      signal,
    })],
    ["logout", (controls, profile, signal) => controls.logout({ profile, signal })],
    ["list sessions", (controls, profile, signal) => controls.listSessions({ profile, signal })],
    ["delete session", (controls, profile, signal) => controls.deleteSession({
      profile,
      providerSessionId: opaqueToken("session"),
      signal,
    })],
  ])("does not invoke %s after cancellation during lazy runtime loading", async (_name, invoke) => {
    let resolveRuntime;
    const loadAgentRuntime = vi.fn(() => new Promise((resolve) => { resolveRuntime = resolve; }));
    const runtime = {
      probeAcpProfile: vi.fn(),
      authenticateAcpProfile: vi.fn(),
      logoutAcpProfile: vi.fn(),
      listAcpSessions: vi.fn(),
      validateAcpProviderSessionId: vi.fn(),
      deleteAcpSession: vi.fn(),
    };
    const { db, profile, controls } = setup(null, { loadAgentRuntime });
    const controller = new AbortController();
    try {
      const result = invoke(controls, profile, controller.signal);
      await vi.waitFor(() => expect(loadAgentRuntime).toHaveBeenCalledTimes(1));
      controller.abort(new Error("cancelled during runtime load"));
      resolveRuntime(runtime);

      await expect(result).rejects.toThrow("cancelled during runtime load");
      for (const method of Object.values(runtime)) expect(method).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
