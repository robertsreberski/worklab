import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  createStderrTail,
  FAILURE_KINDS,
  retryableProviderFailureInfo,
} from "../../ai/failure.js";

describe("classifyFailure", () => {
  it("returns null for clean exit", () => {
    expect(classifyFailure({ exitCode: 0 })).toBeNull();
  });

  it("classifies budget exceeded first", () => {
    expect(classifyFailure({ budgetExceeded: true, errorText: "rate limit" })).toBe("budget_exceeded");
  });

  it("classifies child failure", () => {
    expect(classifyFailure({ childFailed: true })).toBe("child_failed");
  });

  it("classifies invalid result before timeout", () => {
    expect(classifyFailure({ resultParseError: true, timedOut: true })).toBe("invalid_result");
  });

  it("classifies timeout", () => {
    expect(classifyFailure({ timedOut: true })).toBe("timeout");
  });

  it("classifies user cancellation", () => {
    expect(classifyFailure({ cancelRequested: true, cancelInitiator: "user" })).toBe("cancelled_user");
    expect(classifyFailure({ cancelRequested: true, cancelInitiator: "api_cancel" })).toBe("cancelled_user");
    expect(classifyFailure({ cancelRequested: true })).toBe("cancelled");
  });

  it("classifies stale cancel as cancelled_stale", () => {
    expect(classifyFailure({ cancelRequested: true, cancelInitiator: "stale_reconcile" })).toBe("cancelled_stale");
  });

  it("distinguishes coordinator shutdown from stale cancel (R5)", () => {
    expect(classifyFailure({ cancelRequested: true, cancelInitiator: "coordinator_shutdown" })).toBe("cancelled_shutdown");
  });

  it("classifies raw cancellation exits and signals", () => {
    expect(classifyFailure({ exitCode: 130 })).toBe("cancelled_signal");
    expect(classifyFailure({ signal: "SIGTERM" })).toBe("cancelled_signal");
    expect(classifyFailure({ signal: "SIGINT" })).toBe("cancelled_signal");
  });

  it("classifies SIGKILL with no code as abandoned", () => {
    expect(classifyFailure({ signal: "SIGKILL" })).toBe("abandoned");
  });

  it("respects an explicit hint when valid", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "x", hint: "tool_failure" })).toBe("tool_failure");
    expect(classifyFailure({ exitCode: 1, errorText: "x", hint: "invalid_delegation" })).toBe("invalid_delegation");
  });

  it("ignores invalid hints", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "x", hint: "made_up" })).toBe("spawn");
  });

  it("matches usage limit messages from stderr", () => {
    expect(classifyFailure({ exitCode: 2, stderrTail: "rate limit reached" })).toBe("usage_limit");
    expect(classifyFailure({ exitCode: 2, errorText: "Max turns" })).toBe("usage_limit");
  });

  it("matches provider unavailable messages", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "fetch failed: ECONNRESET" })).toBe("provider_unavailable");
    expect(classifyFailure({ exitCode: 1, stderrTail: "503 Service Unavailable" })).toBe("provider_unavailable");
  });

  it("matches tool failure messages", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "tool Edit failed" })).toBe("tool_failure");
  });

  it("falls back to spawn", () => {
    expect(classifyFailure({ exitCode: 127, errorText: "command not found" })).toBe("spawn");
  });

  it("FAILURE_KINDS includes the new entries", () => {
    expect(FAILURE_KINDS).toEqual(expect.arrayContaining([
      "budget_exceeded", "child_failed", "cancelled", "cancelled_user", "cancelled_stale", "cancelled_signal",
      "invalid_delegation", "provider_unavailable_exhausted",
    ]));
  });

  it("FAILURE_KINDS distinguishes provider_unavailable from provider_unavailable_exhausted", () => {
    expect(FAILURE_KINDS).toContain("provider_unavailable");
    expect(FAILURE_KINDS).toContain("provider_unavailable_exhausted");
  });
});

describe("createStderrTail", () => {
  it("keeps only the last `limit` bytes", () => {
    const tail = createStderrTail({ limit: 16 });
    tail.push("aaaaaaaa");
    tail.push("bbbbbbbb");
    tail.push("cccccccc");
    expect(tail.toString()).toContain("cccccccc");
    expect(tail.toString()).not.toContain("aaaaaaaa");
  });

  it("notes how many bytes were dropped", () => {
    const tail = createStderrTail({ limit: 4 });
    tail.push("abcdef");
    expect(tail.bytesDropped).toBe(2);
    expect(tail.toString()).toMatch(/^\[truncated 2 earlier bytes\]/);
  });

  it("handles a single chunk larger than limit", () => {
    const tail = createStderrTail({ limit: 4 });
    tail.push("abcdefghij");
    expect(tail.toString()).toContain("ghij");
  });

  it("accepts buffer-like values via toString", () => {
    const tail = createStderrTail({ limit: 8 });
    tail.push(Buffer.from("hello "));
    tail.push("world");
    expect(tail.toString()).toContain("world");
  });
});

describe("retryableProviderFailureInfo", () => {
  it("marks overloaded provider errors as retryable", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "Our servers are currently overloaded. Please try again later.",
    })).toMatchObject({ retryable: true, subkind: "overloaded" });
  });

  it("extracts request IDs from generic retryable provider messages", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "An error occurred while processing your request. You can retry your request. Please include the request ID 7e4dca0a-6e17-486c-9af6-59785816e5de.",
    })).toMatchObject({
      retryable: true,
      subkind: "retryable_request",
      requestId: "7e4dca0a-6e17-486c-9af6-59785816e5de",
    });
  });

  it("treats provider-side terminated aborts as retryable", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "terminated",
    })).toMatchObject({ retryable: true, subkind: "terminated" });
  });

  it.each([
    "socket hang up",
    "UND_ERR_SOCKET",
    "ECONNRESET while reading response",
    "Premature close",
    "Stream disconnected before completion",
    "WebSocket error",
    "websocket disconnected before completion",
  ])("treats %s as a retryable provider termination", (message) => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: message,
    })).toMatchObject({ retryable: true, subkind: "terminated" });
  });

  it("does not treat generic termination text as retryable without provider classification", () => {
    expect(retryableProviderFailureInfo({
      errorText: "terminated",
    })).toMatchObject({ retryable: false, subkind: null });
  });

  it("does not treat generic WebSocket text as retryable without provider classification", () => {
    expect(retryableProviderFailureInfo({
      errorText: "WebSocket error",
    })).toMatchObject({ retryable: false, subkind: null });
  });

  it("keeps nonretryable provider errors terminal", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "invalid_request_error: Unknown parameter: prompt_cache_retention",
    })).toMatchObject({ retryable: false, subkind: "non_retryable" });
  });
});
