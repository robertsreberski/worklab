import { describe, it, expect } from "vitest";
import { classifyFailure, createStderrTail, FAILURE_KINDS } from "../../core/failure-kind.js";

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
    expect(classifyFailure({ cancelRequested: true })).toBe("cancelled_user");
  });

  it("classifies stale cancel as cancelled_stale", () => {
    expect(classifyFailure({ cancelRequested: true, cancelInitiator: "stale_reconcile" })).toBe("cancelled_stale");
    expect(classifyFailure({ cancelRequested: true, cancelInitiator: "coordinator_shutdown" })).toBe("cancelled_stale");
  });

  it("classifies SIGKILL with no code as abandoned", () => {
    expect(classifyFailure({ signal: "SIGKILL" })).toBe("abandoned");
  });

  it("respects an explicit hint when valid", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "x", hint: "tool_failure" })).toBe("tool_failure");
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
      "budget_exceeded", "child_failed", "cancelled_user", "cancelled_stale",
    ]));
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
