import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorklabAcpControls } from "../../core/acp-controls.js";
import { createAcpProfile } from "../../core/acp-profiles.js";
import { makeTestDb } from "../helpers/test-db.js";

const cleanup = [];
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(agentRuntime) {
  const db = makeTestDb();
  const cwd = mkdtempSync(join(tmpdir(), "worklab-acp-controls-"));
  cleanup.push(cwd);
  const profile = createAcpProfile({
    db,
    id: PROFILE_ID,
    input: {
      agentName: "external",
      displayName: "External",
      command: process.execPath,
      cwd,
      envKeys: [],
    },
  });
  const controls = createWorklabAcpControls({
    db,
    env: {},
    agentRuntime,
    monoDiscoveryControls: {
      discoverMono: vi.fn(),
      resolveMonoSource: vi.fn(),
    },
  });
  return { db, profile, controls };
}

describe("createWorklabAcpControls", () => {
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
      listAcpSessions: vi.fn(async (id) => ({ profileId: id, sessions: [] })),
      decodeAcpProviderSessionId: vi.fn(() => ({ profileId: PROFILE_ID, sessionId: "remote-1" })),
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
      await expect(controls.listSessions({ profile, signal }))
        .resolves.toMatchObject({ sessions: [] });
      const opaque = `acp:v1:${PROFILE_ID}:cmVtb3RlLTE`;
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
        {},
        expect.objectContaining({ resolveAcpProfile: expect.any(Function), signal }),
      );
      expect(runtime.deleteAcpSession).toHaveBeenCalledWith(
        opaque,
        expect.objectContaining({ resolveAcpProfile: expect.any(Function), signal }),
      );
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
          payload: { options: [{ optionId: "allow-once", name: "Allow once" }] },
        }, { requestId: 42 });
        expect(response).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
        return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
      }),
      authenticateAcpProfile: vi.fn(async (_id, _method, options) => {
        const response = await options.onAcpInteractionRequest({
          kind: "elicitation",
          payload: {
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
    } finally {
      db.close();
    }
  });

  it("rejects opaque sessions owned by a different ACP profile before deletion", async () => {
    const runtime = {
      decodeAcpProviderSessionId: vi.fn(() => ({
        profileId: "22222222-2222-4222-8222-222222222222",
        sessionId: "remote-1",
      })),
      deleteAcpSession: vi.fn(),
    };
    const { db, profile, controls } = setup(runtime);
    try {
      await expect(controls.deleteSession({
        profile,
        providerSessionId: `acp:v1:${PROFILE_ID}:cmVtb3RlLTE`,
      })).rejects.toMatchObject({ code: "invalid_session_id" });
      expect(runtime.deleteAcpSession).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
