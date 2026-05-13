import { describe, expect, it, vi } from "vitest";
import { emitFinalResult } from "../../worker/result-emitter.js";

describe("emitFinalResult", () => {
  it("includes provider session ids on successful final events", () => {
    const emit = vi.fn();

    const exitCode = emitFinalResult({ emit }, {
      kind: "task",
      text: "done",
      usage: {},
      durationMs: 10,
      numTurns: 1,
      model: "claude-sonnet-4-6",
      effort: "medium",
      providerSessionId: "claude-session-1",
      worklabResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "advance",
        summary: "Done.",
        details: "Done.",
        final_text: "Done.",
        artifacts: {},
        blocking_issues: [],
        pending_actions: [],
        questions: [],
        subtasks: [],
      },
    });

    expect(exitCode).toBe(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "final",
      provider_session_id: "claude-session-1",
    }));
  });

  it("emits runtime warnings before terminal provider errors", () => {
    const emit = vi.fn();

    const exitCode = emitFinalResult({ emit }, {
      kind: "task",
      error: "Claude result error (max structured output retries): Failed to provide valid structured output after 5 attempts",
      failureKind: "invalid_result",
      runtimeWarnings: [{
        warning_kind: "worklab_result_validation",
        message: "Claude exhausted structured output retries.",
      }],
    });

    expect(exitCode).toBe(1);
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(["runtime_warning", "error"]);
    expect(emit.mock.calls[0][0]).toMatchObject({
      type: "runtime_warning",
      warning_kind: "worklab_result_validation",
    });
    expect(emit.mock.calls[1][0]).toMatchObject({
      type: "error",
      failureKind: "invalid_result",
    });
  });

  it("emits provider diagnostics with terminal error events", () => {
    const emit = vi.fn();

    const exitCode = emitFinalResult({ emit }, {
      kind: "task",
      error: "fetch failed",
      failureKind: "provider_unavailable",
      errorDetails: { pi_transport: "sse" },
      diagnostics: { pi_transport: "sse", turn_count: 19 },
    });

    expect(exitCode).toBe(1);
    expect(emit).toHaveBeenCalledWith({
      type: "error",
      message: "fetch failed",
      failureKind: "provider_unavailable",
      details: { pi_transport: "sse" },
      diagnostics: { pi_transport: "sse", turn_count: 19 },
    });
  });
});
