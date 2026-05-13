import { describe, expect, it } from "vitest";
import {
  describeFailure,
  formatCost,
  formatDuration,
  formatMode,
  formatRunPhase,
  formatRunSummaryTitle,
  formatTokens,
  runResultPreview,
  runMetricItems,
} from "../../ui/src/lib/runFormatting.js";

describe("run formatting helpers", () => {
  it("formats common run values consistently", () => {
    expect(formatDuration(7420)).toBe("7.4s");
    expect(formatDuration(127_000)).toBe("2m 7s");
    expect(formatTokens(3300)).toBe("3.3k");
    expect(formatCost(0.0188)).toBe("$0.0188");
    expect(formatMode("review")).toBe("Review");
  });

  it("builds compact metric items from a run", () => {
    expect(runMetricItems({
      started_at: 1000,
      ended_at: 8000,
      log: {
        input_tokens: 1200,
        output_tokens: 800,
        cost_usd: 0.0123,
        num_turns: 3,
      },
    })).toEqual([
      ["Duration", "7.0s"],
      ["Turns", "3"],
      ["Tokens", "2.0k"],
      ["Cost", "$0.0123"],
    ]);
  });

  it("builds run summary titles from phase only", () => {
    expect(formatRunSummaryTitle({ stage: "execute", mode: "review", agent_name: "sample-agent" }, "7m")).toBe("Execute");
    expect(formatRunSummaryTitle({ mode: "review", agent_name: "sample-agent" }, "now")).toBe("Review");
    expect(formatRunSummaryTitle({ stage: "plan" })).toBe("Plan");
  });

  it("does not include agent names in run summary titles", () => {
    expect(formatRunPhase({ stage: "execute", mode: "execute", agent_name: "Sample Agent" })).toBe("Execute");
    expect(formatRunSummaryTitle({ stage: "execute", agent_name: "Sample Agent" }, "7m")).toBe("Execute");
  });

  it("builds structured run result previews from parsed result metadata", () => {
    expect(runResultPreview({
      decision: "block",
      summary: "legacy summary",
      result: {
        schema: "worklab.v2",
        decision: "advance",
        summary: "Implemented it",
        details: "Changed the files and verified tests.",
      },
    })).toEqual({
      decision: "advance",
      summary: "Implemented it",
      details: "Changed the files and verified tests.",
      tone: "ok",
      hasResult: true,
    });
  });

  it("falls back to legacy run columns and suppresses duplicate details", () => {
    expect(runResultPreview({
      decision: "reject",
      summary: "Needs tests",
      details: "Needs tests",
    })).toEqual({
      decision: "reject",
      summary: "Needs tests",
      details: "",
      tone: "error",
      hasResult: true,
    });
  });

  it("prefers a structured failure summary over stale successful result metadata", () => {
    expect(runResultPreview({
      process_status: "failed",
      error_text: "Claude stopped before final output: max turns reached",
      result: {
        schema: "worklab.v2",
        decision: "advance",
        summary: "technical progress",
        details: "more progress",
      },
    })).toEqual({
      decision: "failed",
      summary: "Run failed.",
      details: "",
      tone: "error",
      hasResult: true,
    });
  });

  it("does not show stale spawn failure kinds for cancelled runs", () => {
    expect(runResultPreview({
      process_status: "cancelled",
      failure_kind: "spawn",
    })).toEqual({
      decision: "cancelled",
      summary: "Run cancelled",
      details: "",
      tone: "",
      hasResult: true,
    });
  });

  it("summarizes cancellation initiator and reason when available", () => {
    expect(runResultPreview({
      process_status: "cancelled",
      failure_kind: "cancelled_signal",
      cancel_initiator: "worker_signal",
      cancel_reason: "worker received SIGTERM",
    }).summary).toBe("Run cancelled (worker_signal: worker received SIGTERM)");
  });

  it("summarizes cancellation failure kinds when no initiator was recorded", () => {
    expect(runResultPreview({
      process_status: "cancelled",
      failure_kind: "cancelled_signal",
    }).summary).toBe("Run cancelled (signal)");
    expect(runResultPreview({
      process_status: "cancelled",
      failure_kind: "cancelled",
    }).summary).toBe("Run cancelled (runtime)");
  });

  it("keeps neutral decision tones neutral", () => {
    expect(runResultPreview({ decision: "delegate", summary: "Split work" }).tone).toBe("");
  });

  it("describes provider termination with auto-retry messaging when below limit", () => {
    expect(describeFailure({
      failure_kind: "provider_unavailable",
      diagnostics: { provider_error_subkind: "terminated", retryable_provider_error: true },
      continuation: { depth: 1 },
    }, { continuationLimit: 3 })).toBe(
      "Provider stream was interrupted before the agent finished. Worklab is retrying automatically.",
    );
  });

  it("switches to retry-prompt at the continuation limit", () => {
    expect(describeFailure({
      failure_kind: "provider_unavailable",
      diagnostics: { provider_error_subkind: "terminated", retryable_provider_error: true },
      continuation: { depth: 3 },
    }, { continuationLimit: 3 })).toBe(
      "Provider stream was interrupted before the agent finished. Click Retry to try again.",
    );
  });

  it("describes the exhausted continuation case", () => {
    const result = describeFailure({ failure_kind: "provider_unavailable_exhausted" });
    expect(result).toContain("exhausted");
  });

  it("returns null when the failure kind is unknown and the run is not failed", () => {
    expect(describeFailure({ failure_kind: "weird" })).toBeNull();
  });

  it("falls back to a generic message for failed runs without a failure kind", () => {
    expect(describeFailure({ process_status: "failed" })).toBe("Run failed.");
  });
});
