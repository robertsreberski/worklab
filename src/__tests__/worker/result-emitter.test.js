import { describe, expect, it, vi } from "vitest";
import { emitCancelledEvent, emitFinalResult } from "../../worker/result-emitter.js";

const PROVIDER_SESSION_ID = "acp:v1:profile-1:opaque-session";
const RAW_PROTOCOL_RESULT = {
  sessionId: "upstream-session-id",
  messages: [{ role: "assistant", content: "raw protocol output must stay private" }],
};

function expectSanitizedProviderSession(event) {
  expect(event).toMatchObject({ provider_session_id: PROVIDER_SESSION_ID });
  expect(event).not.toHaveProperty("providerSessionId");
  expect(event).not.toHaveProperty("protocolResult");
  expect(JSON.stringify(event)).not.toContain("raw protocol output must stay private");
}

describe("emitFinalResult", () => {
  it.each([
    ["consolidate", {}],
    ["automation", {}],
    ["task", { worklabResult: { schema: "worklab.v2" } }],
    ["review", { worklabResult: { schema: "worklab.v2" }, verdict: "APPROVE", notes: "Looks good." }],
    ["lead_cycle", { leadCycleResult: { schema: "worklab.lead_cycle.v1" } }],
  ])("includes only the sanitized provider session payload on successful %s final events", (kind, extra) => {
    const emit = vi.fn();

    const exitCode = emitFinalResult({ emit }, {
      kind,
      text: "done",
      usage: {},
      durationMs: 10,
      numTurns: 1,
      model: "claude-sonnet-4-6",
      effort: "medium",
      providerSessionId: PROVIDER_SESSION_ID,
      protocolResult: RAW_PROTOCOL_RESULT,
      ...extra,
    });

    expect(exitCode).toBe(0);
    const finalEvent = emit.mock.calls.find(([event]) => event.type === "final")?.[0];
    expect(finalEvent).toBeTruthy();
    expectSanitizedProviderSession(finalEvent);
  });

  it("includes only the sanitized provider session payload on cancellations", () => {
    const emit = vi.fn();

    const exitCode = emitFinalResult({ emit }, {
      kind: "task",
      cancelled: true,
      providerSessionId: PROVIDER_SESSION_ID,
      protocolResult: RAW_PROTOCOL_RESULT,
    });

    expect(exitCode).toBe(130);
    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0][0];
    expect(event.type).toBe("cancelled");
    expectSanitizedProviderSession(event);
  });

  it("preserves provider sessions on coordinator drain cancellation events", () => {
    const emit = vi.fn();

    emitCancelledEvent(emit, {
      providerSessionId: PROVIDER_SESSION_ID,
      protocolResult: RAW_PROTOCOL_RESULT,
    }, {
      initiator: "coordinator_shutdown",
      drained: true,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0][0];
    expect(event).toMatchObject({
      type: "cancelled",
      initiator: "coordinator_shutdown",
      drained: true,
    });
    expectSanitizedProviderSession(event);
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
      providerSessionId: PROVIDER_SESSION_ID,
      protocolResult: RAW_PROTOCOL_RESULT,
    });

    expect(exitCode).toBe(1);
    expect(emit).toHaveBeenCalledWith({
      type: "error",
      message: "fetch failed",
      failureKind: "provider_unavailable",
      details: { pi_transport: "sse" },
      diagnostics: { pi_transport: "sse", turn_count: 19 },
      provider_session_id: PROVIDER_SESSION_ID,
    });
    expectSanitizedProviderSession(emit.mock.calls[0][0]);
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
      providerSessionId: PROVIDER_SESSION_ID,
      protocolResult: RAW_PROTOCOL_RESULT,
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
      provider_session_id: PROVIDER_SESSION_ID,
    });
    expectSanitizedProviderSession(emit.mock.calls[2][0]);
  });

  it.each([
    ["review", { parsedResultFatalMessage: "invalid reviewer result" }],
    ["lead_cycle", {}],
  ])("includes only the sanitized provider session payload on %s parse errors", (kind, extra) => {
    const emit = vi.fn();

    const exitCode = emitFinalResult({ emit }, {
      kind,
      parsedResultError: "invalid structured result",
      parsedResultFatal: true,
      providerSessionId: PROVIDER_SESSION_ID,
      protocolResult: RAW_PROTOCOL_RESULT,
      ...extra,
    });

    expect(exitCode).toBe(1);
    const errorEvent = emit.mock.calls.find(([event]) => event.type === "worklab_result_error")?.[0];
    expect(errorEvent).toBeTruthy();
    expectSanitizedProviderSession(errorEvent);
  });

  it("includes only the sanitized provider session payload on unknown-runner errors", () => {
    const emit = vi.fn();

    const exitCode = emitFinalResult({ emit }, {
      kind: "unexpected",
      providerSessionId: PROVIDER_SESSION_ID,
      protocolResult: RAW_PROTOCOL_RESULT,
    });

    expect(exitCode).toBe(1);
    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0][0];
    expect(event).toMatchObject({ type: "error", message: "unknown runner kind: unexpected" });
    expectSanitizedProviderSession(event);
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
