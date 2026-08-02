import { describe, expect, it } from "vitest";
import {
  externalAgentDraftValidation,
  opaqueSessionReference,
  recoverAcpManagementState,
  restoreAcpSessionListing,
} from "../../ui/src/routes/ExternalAgentEdit.jsx";

const PROFILE_ID = "3d6143ec-d863-4df5-ac27-9bf32832ae86";
const SESSION_ONE = `acp:v1:${PROFILE_ID}:c2Vzc2lvbi1vbmU`;
const SESSION_TWO = `acp:v1:${PROFILE_ID}:c2Vzc2lvbi10d28`;
const CURSOR_ONE = `acp-cursor:v1:${PROFILE_ID}:Y3Vyc29yLW9uZQ`;

function operation(overrides = {}) {
  return {
    id: "acpo-one",
    profileId: PROFILE_ID,
    kind: "list_sessions",
    state: "succeeded",
    request: {},
    result: { sessions: [], truncated: false },
    error: {},
    createdAt: 1_754_136_000_000,
    updatedAt: 1_754_136_000_100,
    startedAt: 1_754_136_000_010,
    completedAt: 1_754_136_000_100,
    ...overrides,
  };
}

describe("external agent editor state", () => {
  it("requires the backend lowercase slug and an executable for new generic profiles", () => {
    const draft = {
      agentName: "Needs Spaces",
      displayName: "Generic agent",
      configurationOwner: "agent",
      workspaceOwner: "client",
      command: "relative-agent",
      cwd: "",
      canonicalWorkspace: "",
      envKeysText: "PATH",
      probeTimeoutMs: 30_000,
      sessionModeId: "",
    };
    const invalid = externalAgentDraftValidation(draft, { isNew: true, driver: "generic" });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toMatchObject({
      agentName: expect.stringContaining("lowercase slug"),
      configurationOwner: expect.stringContaining("must keep launch configuration in Worklab"),
      command: expect.stringContaining("absolute executable"),
    });

    expect(externalAgentDraftValidation({
      ...draft,
      agentName: "generic-agent-1",
      configurationOwner: "client",
      command: "/opt/bin/generic-agent",
    }, { isNew: true, driver: "generic" }).valid).toBe(true);
  });

  it("restores a paginated opaque session chain from backend operation rows", () => {
    const operations = [
      operation({
        id: "acpo-page-two",
        request: { cursor: CURSOR_ONE },
        result: { sessions: [{ id: SESSION_TWO, title: "Second" }], truncated: false },
        createdAt: 1_754_136_002_000,
      }),
      operation({
        id: "acpo-page-one",
        result: { sessions: [{ id: SESSION_ONE, title: "First" }], nextCursor: CURSOR_ONE, truncated: true },
        createdAt: 1_754_136_001_000,
      }),
      operation({
        id: "acpo-old-delete",
        kind: "delete_session",
        request: { providerSessionId: SESSION_ONE },
        result: { deleted: true, id: SESSION_ONE },
        createdAt: 1_754_135_000_000,
      }),
    ];

    expect(restoreAcpSessionListing(operations, PROFILE_ID)).toEqual({
      sessions: [
        { id: SESSION_ONE, title: "First", status: "", createdAt: null, updatedAt: null },
        { id: SESSION_TWO, title: "Second", status: "", createdAt: null, updatedAt: null },
      ],
      nextCursor: null,
      truncated: false,
      restored: true,
    });
    expect(opaqueSessionReference(SESSION_ONE)).toMatch(/^acp:v1:.*….*$/u);
  });

  it("does not resurrect a session deleted after the restored listing", () => {
    const listing = operation({
      id: "acpo-list-before-delete",
      result: { sessions: [{ id: SESSION_ONE, title: "Delete me" }], truncated: false },
      createdAt: 1_754_136_001_000,
    });
    const deletion = operation({
      id: "acpo-delete-after-list",
      kind: "delete_session",
      request: { providerSessionId: SESSION_ONE },
      result: { deleted: true, id: SESSION_ONE },
      createdAt: 1_754_136_002_000,
    });

    expect(restoreAcpSessionListing([deletion, listing], PROFILE_ID)).toMatchObject({
      sessions: [],
      restored: true,
    });
  });

  it("rejects raw session ids and recovers active and restart history without exposing internals", () => {
    const active = operation({ id: "acpo-active", kind: "probe", state: "running", result: {} });
    const restarted = operation({
      id: "acpo-restarted",
      kind: "authenticate",
      state: "failed",
      result: {},
      error: {
        code: "coordinator_restarted",
        message: "Worklab restarted before the ACP operation completed.",
      },
      createdAt: 1_754_135_000_000,
    });
    const unsafeList = operation({
      id: "acpo-unsafe",
      result: { sessions: [{ id: "raw/provider/session", title: "Must not render" }], truncated: true },
      createdAt: 1_754_134_000_000,
    });
    const recovered = recoverAcpManagementState({ operations: [active, restarted, unsafeList] }, PROFILE_ID);

    expect(recovered.activeOperation).toBe(active);
    expect(recovered.latestOperation).toBe(active);
    expect(recovered.coordinatorRestartOperation).toBe(restarted);
    expect(recovered.sessionListing.sessions).toEqual([]);
    expect(JSON.stringify(recovered.sessionListing)).not.toContain("raw/provider/session");
  });
});
