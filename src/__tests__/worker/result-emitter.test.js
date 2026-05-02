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
});
