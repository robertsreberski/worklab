import { describe, expect, it } from "vitest";

import {
  normalizeAcpSessionCursor,
  rowToAcpInteraction,
  rowToAcpOperation,
  sanitizeAcpInteractionRequest,
  sanitizeAcpInteractionSchema,
  sanitizeAcpOperationError,
  sanitizeAcpOperationResult,
} from "../../core/acp-operations.js";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const MAX_PERSISTED_JSON_BYTES = 64 * 1024;

function sealedToken(raw) {
  return Buffer.concat([
    Buffer.alloc(12, 0x6e),
    Buffer.from(raw),
    Buffer.alloc(16, 0x74),
  ]).toString("base64url");
}

function opaqueSessionId(raw, profileId = PROFILE_ID) {
  return `acp:v2:${profileId}:${sealedToken(raw)}`;
}

function opaqueCursor(raw, profileId = PROFILE_ID) {
  return `acp-cursor:v2:${profileId}:${sealedToken(raw)}`;
}

describe("sanitizeAcpOperationResult", () => {
  it("redacts embedded numeric and boolean private-response scalars", () => {
    const privateValues = new Set([493827, true]);

    expect(sanitizeAcpOperationResult("authenticate", {
      authenticated: true,
      status: "OTP493827END approved=true-ish",
      warnings: ["PIN493827", "untruevalue"],
    }, { privateValues })).toEqual({
      authenticated: "[redacted]",
      status: "OTP[redacted]END approved=[redacted]-ish",
      warnings: ["PIN[redacted]", "un[redacted]value"],
    });
    expect(sanitizeAcpOperationError("authenticate", {
      code: "runtime_PIN493827END_APPROVEDtrueISH",
    }, { privateValues })).toEqual({
      code: "operation_failed",
      message: "ACP authenticate operation failed.",
    });
  });

  it("redacts private response strings before clipping public fields", () => {
    const privateValue = "TOP-SECRET-VALUE";
    const prefix = "a".repeat(495);
    const result = sanitizeAcpOperationResult("probe", {
      authMethods: [{
        id: "browser-login",
        name: `${prefix}${privateValue}`,
        type: "agent",
      }],
    }, { privateValues: new Set([privateValue]) });

    expect(result.authMethods).toHaveLength(1);
    expect(result.authMethods[0].name).not.toContain("TOP-S");
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(sanitizeAcpOperationError("probe", {
      code: `${"a".repeat(99)}${privateValue}`,
    }, { privateValues: new Set([privateValue]) }).code).toBe("operation_failed");
  });

  it("does not decode v2 ciphertext to match private-response scalars", () => {
    const privateValue = "private-form-value";
    const privateValues = new Set([privateValue]);
    const providerSessionId = opaqueSessionId(privateValue);
    const nextCursor = opaqueCursor(`page:${privateValue}`);

    expect(sanitizeAcpOperationResult("list_sessions", {
      sessions: [{ providerSessionId, title: "Private handle" }],
      nextCursor,
    }, { profileId: PROFILE_ID, privateValues })).toEqual({
      sessions: [{ id: providerSessionId, title: "Private handle" }],
      nextCursor,
      truncated: true,
    });
    expect(sanitizeAcpOperationResult("delete_session", {
      deleted: true,
      providerSessionId,
    }, { profileId: PROFILE_ID, privateValues })).toEqual({ deleted: true, id: providerSessionId });
    expect(sanitizeAcpOperationResult("delete_session", {
      deleted: true,
      providerSessionId,
    }, { profileId: PROFILE_ID, privateValues, privacyFailedClosed: true })).toEqual({
      truncated: true,
    });
  });

  it("redacts exact private values that are structurally valid v2 handles", () => {
    const privateSessionId = opaqueSessionId("v2-shaped-form-secret");
    const privateCursor = opaqueCursor("v2-shaped-cursor-secret");
    const privateValues = new Set([privateSessionId, privateCursor]);

    expect(sanitizeAcpOperationResult("list_sessions", {
      sessions: [{ providerSessionId: privateSessionId, title: "Private session" }],
      nextCursor: privateCursor,
    }, { profileId: PROFILE_ID, privateValues })).toEqual({
      sessions: [],
      truncated: true,
    });
    expect(sanitizeAcpOperationResult("delete_session", {
      deleted: true,
      providerSessionId: privateSessionId,
    }, { profileId: PROFILE_ID, privateValues })).toEqual({ deleted: true });
    expect(sanitizeAcpOperationResult("probe", {
      warnings: [privateSessionId],
      capabilities: { cursor: privateCursor },
    }, { privateValues })).toEqual({
      warnings: ["[redacted]"],
      capabilities: { cursor: "[redacted]" },
    });
    expect(sanitizeAcpInteractionSchema({
      title: privateSessionId,
      nested: { defaultCursor: privateCursor },
    }, { privateValues })).toEqual({
      title: "[redacted]",
      nested: { defaultCursor: "[redacted]" },
    });
  });

  it("retains a usable bounded session prefix and continuation cursor for large pages", () => {
    const rawCursor = `page-2/${"c".repeat(1_900)}`;
    const nextCursor = opaqueCursor(rawCursor);
    const sourceSessions = Array.from({ length: 200 }, (_, index) => {
      const rawSessionId = `raw-session/${index}`;
      return {
        sessionId: rawSessionId,
        providerSessionId: opaqueSessionId(rawSessionId),
        title: `${rawSessionId} ${"Long session title ".repeat(40)}`,
        status: "ready",
      };
    });

    const result = sanitizeAcpOperationResult("list_sessions", {
      sessions: sourceSessions,
      nextCursor,
    }, { profileId: PROFILE_ID });
    const json = JSON.stringify(result);

    expect(result.sessions.length).toBeGreaterThan(0);
    expect(result.sessions.length).toBeLessThan(sourceSessions.length);
    expect(result.nextCursor).toBe(nextCursor);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(MAX_PERSISTED_JSON_BYTES);
    expect(result.sessions.map((session) => session.id)).toEqual(
      sourceSessions.slice(0, result.sessions.length).map((session) => session.providerSessionId),
    );
    expect(result.sessions[0].title).toContain("[redacted]");
    expect(json).not.toContain("raw-session/");
  });

  it("accepts the exact canonical cursor maximum and rejects one additional character", () => {
    const maxProfileId = "p".repeat(128);
    const maxRawCursor = "x".repeat(4_096);
    const exactMaxCursor = opaqueCursor(maxRawCursor, maxProfileId);
    const oversizedRawCursor = `${maxRawCursor}x`;
    const oversizedCursor = opaqueCursor(oversizedRawCursor, maxProfileId);

    expect(exactMaxCursor).toHaveLength(5_642);
    expect(oversizedCursor).toHaveLength(5_643);
    expect(normalizeAcpSessionCursor(exactMaxCursor, maxProfileId)).toBe(exactMaxCursor);
    expect(() => normalizeAcpSessionCursor(
      `acp-cursor:v1:${maxProfileId}:${Buffer.from(maxRawCursor).toString("base64url")}`,
      maxProfileId,
    )).toThrow("cursor is invalid");
    expect(sanitizeAcpOperationResult("list_sessions", {
      sessions: [],
      nextCursor: exactMaxCursor,
    }, { profileId: maxProfileId })).toEqual({
      sessions: [],
      nextCursor: exactMaxCursor,
      truncated: true,
    });
    expect(() => normalizeAcpSessionCursor(oversizedCursor, maxProfileId))
      .toThrow("cursor is invalid");
    expect(sanitizeAcpOperationResult("list_sessions", {
      sessions: [],
      nextCursor: oversizedCursor,
    }, { profileId: maxProfileId })).toEqual({
      sessions: [],
      truncated: true,
    });
  });

  it("redacts raw pagination aliases before sanitizing session metadata", () => {
    const rawCursor = "RAW_CURSOR_COPIED_INTO_METADATA";
    const providerSessionId = opaqueSessionId("remote-session");
    const aliases = [
      "cursor",
      "nextCursor",
      "next_cursor",
      "next-page-cursor",
      "page_token",
      "nextPageToken",
      "continuation_token",
      "next_token",
      "endCursor",
    ];

    for (const alias of aliases) {
      const result = sanitizeAcpOperationResult("list_sessions", {
        sessions: [{
          providerSessionId,
          title: `Continue ${rawCursor}`,
          status: rawCursor,
        }],
        [alias]: rawCursor,
      }, { profileId: PROFILE_ID });

      expect(result).toEqual({
        sessions: [{
          id: providerSessionId,
          title: "Continue [redacted]",
        }],
        truncated: true,
      });
      expect(JSON.stringify(result)).not.toContain(rawCursor);
    }

    const canonicalCursor = opaqueCursor(rawCursor);
    expect(sanitizeAcpOperationResult("list_sessions", {
      sessions: [],
      next_page_token: canonicalCursor,
    }, { profileId: PROFILE_ID })).toEqual({
      sessions: [],
      nextCursor: canonicalCursor,
      truncated: true,
    });
  });

  it("fails closed for non-string and oversized pagination cursors", () => {
    const providerSessionId = opaqueSessionId("remote-session");
    const sessions = [{ providerSessionId, title: "Otherwise safe" }];

    expect(sanitizeAcpOperationResult("list_sessions", {
      sessions,
      nextCursor: { opaque: "not-a-string" },
    }, { profileId: PROFILE_ID })).toEqual({ sessions: [], truncated: true });
    expect(sanitizeAcpOperationResult("list_sessions", {
      sessions,
      continuation_token: "x".repeat(4_097),
    }, { profileId: PROFILE_ID })).toEqual({ sessions: [], truncated: true });
  });

  it("does not mistake elicitation property schemas for pagination state", () => {
    expect(sanitizeAcpInteractionSchema({
      type: "object",
      properties: {
        cursor: { type: "string", title: "Cursor label" },
        next_page_token: { type: "string", title: "Page token label" },
      },
    })).toEqual({
      type: "object",
      properties: {
        cursor: { type: "string", title: "Cursor label" },
        next_page_token: { type: "string", title: "Page token label" },
      },
    });
  });

  it("does not retain a raw session id hidden in session metadata", () => {
    const rawSessionId = "2026-08-02T18:30:00.000Z";
    const providerSessionId = opaqueSessionId(rawSessionId);
    const result = sanitizeAcpOperationResult("list_sessions", {
      sessions: [{
        sessionId: rawSessionId,
        providerSessionId,
        title: `Continue ${rawSessionId}`,
        status: `ready:${rawSessionId}`,
        createdAt: rawSessionId,
        updatedAt: rawSessionId,
      }],
    });

    expect(result).toEqual({
      sessions: [{
        id: providerSessionId,
        title: "Continue [redacted]",
        status: "ready:[redacted]",
      }],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain(rawSessionId);
  });

  it("removes nested protocol session identifiers from interaction schemas", () => {
    const rawSessionId = "RAW_NESTED_INTERACTION_SESSION";
    const result = sanitizeAcpInteractionSchema({
      mode: "form",
      _meta: {
        transport: {
          sessionId: rawSessionId,
          nested: { session_id: rawSessionId },
        },
      },
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
    });

    expect(result).toMatchObject({
      mode: "form",
      _meta: { transport: { nested: {} } },
    });
    expect(JSON.stringify(result)).not.toContain(rawSessionId);
  });

  it("redacts raw ids across list metadata and rejects cursors that repeat them", () => {
    const rawSessionId = "RAW_LIST_CURSOR_SESSION";
    const providerSessionId = opaqueSessionId(rawSessionId);
    const result = sanitizeAcpOperationResult("list_sessions", {
      sessions: [{
        sessionId: rawSessionId,
        providerSessionId,
        title: `Continue ${rawSessionId}`,
        status: `ready:${rawSessionId}`,
      }],
      nextCursor: `page:${rawSessionId}:2`,
    }, { profileId: PROFILE_ID });

    expect(result).toEqual({
      sessions: [{
        id: providerSessionId,
        title: "Continue [redacted]",
        status: "ready:[redacted]",
      }],
      truncated: true,
    });
    expect(JSON.stringify(result)).not.toContain(rawSessionId);
  });

  it("scrubs delete status and uses fixed operation error messages", () => {
    const rawSessionId = "RAW_DELETE_STATUS_SESSION";
    const providerSessionId = opaqueSessionId(rawSessionId);
    const result = sanitizeAcpOperationResult("delete_session", {
      sessionId: rawSessionId,
      providerSessionId,
      deleted: true,
      status: `deleted ${rawSessionId}`,
    }, { profileId: PROFILE_ID });

    expect(result).toEqual({ deleted: true, id: providerSessionId });
    expect(sanitizeAcpOperationError("delete_session", {
      code: rawSessionId,
      sessionId: rawSessionId,
      safeMessage: `Could not delete ${rawSessionId}`,
    })).toEqual({
      code: "operation_failed",
      message: "ACP delete_session operation failed.",
    });
  });

  it("redacts protocol ids and display fields before persisting interactions", () => {
    const rawSessionId = "RAW_INTERACTION_PROTOCOL_SESSION";
    const safe = sanitizeAcpInteractionRequest({
      source: {
        context: { sessionId: rawSessionId },
        payload: { title: `Approve ${rawSessionId}` },
      },
      protocolRequestId: `request:${rawSessionId}`,
      requestSchema: {
        title: `Approve ${rawSessionId}`,
        nested: { session_id: rawSessionId, label: `For ${rawSessionId}` },
      },
    });

    expect(safe.protocolRequestId).toMatch(/^acp-request:v1:/u);
    expect(safe.requestSchema).toEqual({
      title: "Approve [redacted]",
      nested: { label: "For [redacted]" },
    });
    expect(JSON.stringify(safe)).not.toContain(rawSessionId);
  });

  it("fails closed when interaction privacy scanning exceeds its depth budget", () => {
    let tooDeep = { sessionId: "RAW_TOO_DEEP_SESSION" };
    for (let depth = 0; depth < 25; depth += 1) tooDeep = { nested: tooDeep };
    const safe = sanitizeAcpInteractionRequest({
      source: tooDeep,
      protocolRequestId: "deep-request",
      requestSchema: { title: "Otherwise safe" },
    });

    expect(safe).toEqual({
      protocolRequestId: expect.stringMatching(/^acp-request:v1:/u),
      requestSchema: { truncated: true },
    });
  });

  it("sanitizes legacy rows and rejects v1 operational handles at read time", () => {
    const rawSessionId = "RAW_LEGACY_MANAGEMENT_SESSION";
    const providerSessionId = `acp:v1:${PROFILE_ID}:${Buffer.from(rawSessionId).toString("base64url")}`;
    const operation = rowToAcpOperation({
      id: "acpo_legacy",
      profile_id: PROFILE_ID,
      kind: "list_sessions",
      state: "failed",
      remote_session_id: rawSessionId,
      request_json: JSON.stringify({ cursor: rawSessionId, sessionId: rawSessionId }),
      result_json: JSON.stringify({
        sessions: [{
          sessionId: rawSessionId,
          providerSessionId,
          title: `Legacy ${rawSessionId}`,
        }],
        nextCursor: `next:${rawSessionId}`,
      }),
      error_json: JSON.stringify({
        code: "protocol",
        publicMessage: `Failed ${rawSessionId}`,
      }),
      created_at: 1,
      updated_at: 2,
      started_at: 1,
      completed_at: 2,
    });
    const interaction = rowToAcpInteraction({
      id: "acpi_legacy",
      profile_id: PROFILE_ID,
      task_run_id: null,
      operation_id: "acpo_legacy",
      protocol_request_id: `request:${rawSessionId}`,
      kind: "form",
      request_schema_json: JSON.stringify({
        sessionId: rawSessionId,
        title: `Legacy form ${rawSessionId}`,
      }),
      state: "pending",
      disposition: null,
      created_at: 1,
      updated_at: 1,
      resolved_at: null,
    });

    expect(operation).toMatchObject({
      remoteSessionId: null,
      request: {},
      result: {
        sessions: [],
        truncated: true,
      },
      error: { code: "protocol", message: "ACP list_sessions operation failed." },
    });
    expect(interaction).toMatchObject({
      protocolRequestId: expect.stringMatching(/^acp-request:v1:/u),
      requestSchema: { title: "Legacy form [redacted]" },
    });
    expect(JSON.stringify({ operation, interaction })).not.toContain(rawSessionId);
  });

  it("preserves canonical v2 handles without decoding their sealed bytes", () => {
    const rawCursor = `next/${"x".repeat(3_000)}`;
    const cursor = opaqueCursor(rawCursor);
    const providerSessionId = opaqueSessionId("remote-safe");
    expect(cursor.length).toBeGreaterThan(2_000);
    expect(normalizeAcpSessionCursor(cursor, PROFILE_ID)).toBe(cursor);
    expect(() => normalizeAcpSessionCursor(cursor, "22222222-2222-4222-8222-222222222222"))
      .toThrow("cursor is invalid");

    const operation = rowToAcpOperation({
      id: "acpo_safe",
      profile_id: PROFILE_ID,
      kind: "list_sessions",
      state: "succeeded",
      remote_session_id: null,
      request_json: JSON.stringify({ cursor }),
      result_json: JSON.stringify({
        sessions: [{ id: providerSessionId, title: `Safe session ${rawCursor}` }],
        nextCursor: cursor,
        truncated: true,
      }),
      error_json: "{}",
      created_at: 1,
      updated_at: 2,
      started_at: 1,
      completed_at: 2,
    });

    expect(operation.request).toEqual({ cursor });
    expect(operation.result).toEqual({
      sessions: [{ id: providerSessionId, title: `Safe session ${rawCursor}`.slice(0, 500) }],
      nextCursor: cursor,
      truncated: true,
    });
  });
});
