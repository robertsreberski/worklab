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

  it("emits parse-failure diagnostics with terminal worklab_result_error events", () => {
    const emit = vi.fn();

    const exitCode = emitFinalResult({ emit }, {
      kind: "task",
      parsedResultError: "missing final output",
      parsedResultFatal: true,
      runtimeWarnings: [{
        warning_kind: "structured_output_finalization_retry",
        source: "pi",
        reason: "empty_final_output",
        message: "retrying structured output finalization",
      }],
      diagnostics: {
        last_tool_name: "journal_summary",
        structured_output_finalization_retry_attempts: 1,
      },
    });

    expect(exitCode).toBe(1);
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
      "runtime_warning",
      "runtime_warning",
      "worklab_result_error",
    ]);
    expect(emit.mock.calls[0][0]).toMatchObject({
      type: "runtime_warning",
      warning_kind: "structured_output_finalization_retry",
      source: "pi",
      reason: "empty_final_output",
    });
    expect(emit.mock.calls[2][0]).toMatchObject({
      type: "worklab_result_error",
      message: "missing final output",
      diagnostics: {
        last_tool_name: "journal_summary",
        structured_output_finalization_retry_attempts: 1,
      },
    });
  });

  it("forwards capabilitiesUsed, failoverHistory, and observerSnapshot on the final event", () => {
    const emit = vi.fn();
    const exitCode = emitFinalResult({ emit }, {
      kind: "task",
      text: "done",
      usage: {},
      durationMs: 10,
      numTurns: 1,
      model: "claude-sonnet-4-6",
      effort: "medium",
      providerSessionId: "claude-session-x",
      capabilitiesUsed: {
        prompt_cache_active: true,
        thinking_enabled: false,
        structured_output_enforced: true,
        subagent_invoked: false,
        mcp_servers_used: ["linear"],
        native_subagents_used: [],
        tool_compaction_applied: false,
        context_compaction_applied: false,
      },
      failoverHistory: [{ model: { sdk: "claude", model: "claude-opus-4-7" }, failureKind: "provider_unavailable", retryableSubkind: "overloaded" }],
      observerSnapshot: { cost: { cumulativeUsd: 0.21 }, cache: { hitRatio: 0.5 } },
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
    const finalEvent = emit.mock.calls.find(([event]) => event.type === "final")?.[0];
    expect(finalEvent).toBeTruthy();
    expect(finalEvent.capabilities_used).toMatchObject({
      prompt_cache_active: true,
      mcp_servers_used: ["linear"],
    });
    expect(finalEvent.failover_history).toHaveLength(1);
    expect(finalEvent.tool_usage_summary).toMatchObject({
      cost: { cumulativeUsd: 0.21 },
      cache: { hitRatio: 0.5 },
    });
  });

  it("omits failover_history when the chain produced no entries", () => {
    const emit = vi.fn();
    emitFinalResult({ emit }, {
      kind: "task",
      text: "done",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "claude-sonnet-4-6",
      effort: "medium",
      failoverHistory: [],
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
    const finalEvent = emit.mock.calls.find(([event]) => event.type === "final")?.[0];
    expect(finalEvent).toBeTruthy();
    expect(finalEvent.failover_history).toBeUndefined();
  });
});
