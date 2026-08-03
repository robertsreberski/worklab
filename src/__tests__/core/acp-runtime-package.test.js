import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import * as agentRuntime from "@mono-agent/agent-runtime";

import { resolveModel } from "../../core/ai.js";

const REQUIRED_ACP_CONTROLS = [
  "probeAcpProfile",
  "authenticateAcpProfile",
  "logoutAcpProfile",
  "listAcpSessions",
  "deleteAcpSession",
  "validateAcpProviderSessionId",
];

const PROFILE_ID = "installed-package";
const RAW_SESSION_ID = "raw-session-only-inside-child-91f55a";
const RAW_CURSOR = "raw-cursor-only-inside-child-4c76d8";
const SESSION_TOKEN_KEY = Buffer.alloc(32, 0x41);
const OTHER_SESSION_TOKEN_KEY = Buffer.alloc(32, 0x42);
const fixture = fileURLToPath(new URL(
  "../fixtures/acp-runtime-package/raw-ndjson-agent.js",
  import.meta.url,
));
const root = mkdtempSync(join(tmpdir(), "worklab-acp-runtime-package-"));
const require = createRequire(import.meta.url);
const runtimeEntry = require.resolve("@mono-agent/agent-runtime");
const runtimePackage = JSON.parse(readFileSync(
  join(dirname(runtimeEntry), "..", "package.json"),
  "utf8",
));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixtureDescriptor(logFile) {
  return {
    command: process.execPath,
    args: [fixture],
    env: {
      WORKLAB_ACP_CONTRACT_LOG: logFile,
      WORKLAB_ACP_CONTRACT_RAW_SESSION_ID: RAW_SESSION_ID,
      WORKLAB_ACP_CONTRACT_RAW_CURSOR: RAW_CURSOR,
    },
    configurationOwner: "agent",
    workspaceOwner: "agent",
    workspacePath: root,
    mcpOwner: "agent",
    sessionConfig: { resumeStrategy: "resume" },
    process: {
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      shutdownGraceMs: 100,
      killGraceMs: 500,
      maxLineBytes: 1024 * 1024,
    },
  };
}

function trackedResolver(logFile, publicLog) {
  return (profileId, context) => {
    publicLog.push({ type: "profile_resolved", profileId, context });
    return fixtureDescriptor(logFile);
  };
}

function runOptions(overrides = {}) {
  return {
    model: {
      sdk: "acp",
      model: PROFILE_ID,
      reference: `acp:${PROFILE_ID}`,
    },
    executionMode: "acp",
    cwd: root,
    messages: [{ role: "user", content: "exercise installed ACP runtime" }],
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

function readFixtureLog(logFile) {
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function tamperSealedHandle(providerSessionId) {
  const payloadStart = providerSessionId.lastIndexOf(":") + 1;
  const mutationIndex = payloadStart + Math.floor((providerSessionId.length - payloadStart) / 2);
  const replacement = providerSessionId[mutationIndex] === "A" ? "B" : "A";
  return `${providerSessionId.slice(0, mutationIndex)}${replacement}${providerSessionId.slice(mutationIndex + 1)}`;
}

describe("installed @mono-agent/agent-runtime ACP contract", () => {
  it("exports the high-level ACP control facade Worklab consumes", () => {
    for (const name of REQUIRED_ACP_CONTROLS) {
      expect(agentRuntime[name], name).toBeTypeOf("function");
    }
  });

  it("parses the canonical acp:<profile-id> model reference", () => {
    expect(resolveModel("acp:demo")).toEqual({
      sdk: "acp",
      model: "demo",
      reference: "acp:demo",
    });
  });

  it("enforces the installed 0.18.2 sealed-session lifecycle through raw ACP NDJSON", async () => {
    // Keep this exact: the lifecycle below is the installed-package contract
    // Worklab relies on, not a mocked facade assertion.
    expect(runtimePackage.version).toBe("0.18.2");

    const publicLog = [];
    const firstLog = join(root, "first.ndjson");
    const first = await agentRuntime.createRuntime({
      acpSessionTokenKey: SESSION_TOKEN_KEY,
      resolveAcpProfile: trackedResolver(firstLog, publicLog),
    }).run("System", runOptions({ onEvent: (event) => publicLog.push(event) }));

    expect(first).toMatchObject({
      error: null,
      failureKind: null,
      providerSessionId: expect.stringMatching(/^acp:v2:installed-package:[A-Za-z0-9_-]+$/),
    });
    expect(first.providerSessionId).not.toContain(RAW_SESSION_ID);
    expect(agentRuntime.validateAcpProviderSessionId(
      first.providerSessionId,
      PROFILE_ID,
      SESSION_TOKEN_KEY,
    )).toBe(first.providerSessionId);
    const tamperedHandle = tamperSealedHandle(first.providerSessionId);
    expect(tamperedHandle).toMatch(/^acp:v2:installed-package:[A-Za-z0-9_-]+$/);
    expect(tamperedHandle).not.toBe(first.providerSessionId);

    const resumeLog = join(root, "resume.ndjson");
    const resumed = await agentRuntime.createRuntime({
      acpSessionTokenKey: SESSION_TOKEN_KEY,
      resolveAcpProfile: trackedResolver(resumeLog, publicLog),
    }).run("System", runOptions({
      providerSessionId: first.providerSessionId,
      messages: [{ role: "user", content: "resume through the sealed handle" }],
      onEvent: (event) => publicLog.push(event),
    }));

    expect(resumed).toMatchObject({
      error: null,
      failureKind: null,
      providerSessionId: first.providerSessionId,
      diagnostics: { acp_resume_method: "resume" },
      capabilitiesUsed: { session_resume: true },
    });
    expect(readFixtureLog(resumeLog)).toContainEqual(expect.objectContaining({
      method: "session/resume",
      params: expect.objectContaining({ sessionId: RAW_SESSION_ID }),
    }));

    const rejectedLog = join(root, "rejected.ndjson");
    const rejectedPublicLog = [];
    const rejectedResolver = trackedResolver(rejectedLog, rejectedPublicLog);
    const legacyHandle = `acp:v1:${PROFILE_ID}:${Buffer.from(RAW_SESSION_ID).toString("base64url")}`;
    for (const [providerSessionId, acpSessionTokenKey] of [
      [first.providerSessionId, OTHER_SESSION_TOKEN_KEY],
      [tamperedHandle, SESSION_TOKEN_KEY],
      [legacyHandle, SESSION_TOKEN_KEY],
    ]) {
      const rejected = await agentRuntime.createRuntime({
        acpSessionTokenKey,
        resolveAcpProfile: rejectedResolver,
      }).run("System", runOptions({ providerSessionId }));

      expect(rejected).toMatchObject({
        failureKind: "provider_protocol",
        errorDetails: { acp_error_code: "invalid_session_id" },
        providerSessionId: null,
      });
      expect(JSON.stringify(rejected)).not.toContain(RAW_SESSION_ID);
    }
    expect(rejectedPublicLog).toEqual([]);
    expect(existsSync(rejectedLog)).toBe(false);

    const listLog = join(root, "list.ndjson");
    const listed = await agentRuntime.listAcpSessions(PROFILE_ID, {}, {
      acpSessionTokenKey: SESSION_TOKEN_KEY,
      resolveAcpProfile: trackedResolver(listLog, publicLog),
    });

    expect(listed).toMatchObject({
      profileId: PROFILE_ID,
      sessions: [{
        providerSessionId: expect.stringMatching(/^acp:v2:installed-package:[A-Za-z0-9_-]+$/),
        cwd: "/tmp/[redacted]",
        title: "Fixture [redacted]",
      }],
      nextCursor: expect.stringMatching(/^acp-cursor:v2:installed-package:[A-Za-z0-9_-]+$/),
    });
    expect(listed.sessions[0]).not.toHaveProperty("sessionId");
    expect(listed.sessions[0]).not.toHaveProperty("_meta");
    expect(JSON.stringify(listed)).not.toContain(RAW_SESSION_ID);
    expect(JSON.stringify(listed)).not.toContain(RAW_CURSOR);

    const deleteLog = join(root, "delete.ndjson");
    const deleted = await agentRuntime.deleteAcpSession(listed.sessions[0].providerSessionId, {
      acpSessionTokenKey: SESSION_TOKEN_KEY,
      resolveAcpProfile: trackedResolver(deleteLog, publicLog),
    });

    expect(deleted).toEqual({
      profileId: PROFILE_ID,
      providerSessionId: listed.sessions[0].providerSessionId,
      deleted: true,
    });
    expect(readFixtureLog(deleteLog)).toContainEqual(expect.objectContaining({
      method: "session/delete",
      params: { sessionId: RAW_SESSION_ID },
    }));

    const publicData = JSON.stringify({ first, resumed, listed, deleted, publicLog });
    expect(publicData).not.toContain(RAW_SESSION_ID);
    expect(publicData).not.toContain(RAW_CURSOR);
  }, 15_000);
});
