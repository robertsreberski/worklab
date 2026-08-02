import { describe, expect, it } from "vitest";

import { sanitizeAcpOperationResult } from "../../core/acp-operations.js";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const MAX_PERSISTED_JSON_BYTES = 64 * 1024;

describe("sanitizeAcpOperationResult", () => {
  it("retains a usable bounded session prefix and continuation cursor for large pages", () => {
    const nextCursor = `page-2/${"c".repeat(1_900)}`;
    const sourceSessions = Array.from({ length: 200 }, (_, index) => {
      const rawSessionId = `raw-session/${index}`;
      return {
        sessionId: rawSessionId,
        providerSessionId: `acp:v1:${PROFILE_ID}:${Buffer.from(rawSessionId).toString("base64url")}`,
        title: `${rawSessionId} ${"Long session title ".repeat(40)}`,
        status: "ready",
      };
    });

    const result = sanitizeAcpOperationResult("list_sessions", {
      sessions: sourceSessions,
      nextCursor,
    });
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

  it("does not retain a raw session id hidden in session metadata", () => {
    const rawSessionId = "2026-08-02T18:30:00.000Z";
    const providerSessionId = `acp:v1:${PROFILE_ID}:${Buffer.from(rawSessionId).toString("base64url")}`;
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
});
