import { describe, expect, it } from "vitest";
import {
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
    expect(formatRunSummaryTitle({ stage: "execute", mode: "review", agent_name: "mickey" }, "7m")).toBe("Execute");
    expect(formatRunSummaryTitle({ mode: "review", agent_name: "mickey" }, "now")).toBe("Review");
    expect(formatRunSummaryTitle({ stage: "plan" })).toBe("Plan");
  });

  it("does not include agent names in run summary titles", () => {
    expect(formatRunPhase({ stage: "execute", mode: "execute", agent_name: "Mickey Mouse" })).toBe("Execute");
    expect(formatRunSummaryTitle({ stage: "execute", agent_name: "Mickey Mouse" }, "7m")).toBe("Execute");
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

  it("prefers failed run error text over stale successful result metadata", () => {
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
      summary: "Claude stopped before final output: max turns reached",
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

  it("keeps neutral decision tones neutral", () => {
    expect(runResultPreview({ decision: "delegate", summary: "Split work" }).tone).toBe("");
  });
});
