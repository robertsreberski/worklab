import { describe, it, expect } from "vitest";
import { extractExecutionFromEvents } from "../../core/review-exec.js";

const AGENT_ROW = { agent_name: "owner-bot" };

describe("extractExecutionFromEvents", () => {
  it("empty events → safe defaults", () => {
    const result = extractExecutionFromEvents([], AGENT_ROW);
    expect(result).toEqual({
      agentName: "owner-bot",
      finalText: "",
      events: [],
      numTurns: 0,
      durationMs: 0,
    });
  });

  it("events with one final at the end → extracts correctly", () => {
    const events = [
      { type: "sdk_event", event: { type: "tool_use" } },
      { type: "sdk_event", event: { type: "tool_result" } },
      { type: "final", text: "Done!", numTurns: 5, durationMs: 1234 },
    ];
    const result = extractExecutionFromEvents(events, AGENT_ROW);
    expect(result).toEqual({
      agentName: "owner-bot",
      finalText: "Done!",
      events,
      numTurns: 5,
      durationMs: 1234,
    });
  });

  it("prefers delivered final text over structured result summary", () => {
    const events = [
      {
        type: "final",
        text: [
          "# Delivered Report",
          "",
          "Useful final content.",
          "",
          "```json",
          "{\"schema\":\"worklab.v2\",\"stage\":\"execute\",\"decision\":\"advance\",\"summary\":\"Short\",\"details\":\"Metadata\",\"artifacts\":{},\"blocking_issues\":[],\"pending_actions\":[],\"subtasks\":[]}",
          "```",
        ].join("\n"),
        worklab_result: {
          schema: "worklab.v2",
          decision: "advance",
          summary: "Short",
          details: "Metadata",
        },
      },
    ];
    const result = extractExecutionFromEvents(events, AGENT_ROW);
    expect(result.finalText).toBe("# Delivered Report\n\nUseful final content.");
  });

  it("falls back to structured result text when final text is absent", () => {
    const events = [
      {
        type: "final",
        worklab_result: {
          schema: "worklab.v2",
          decision: "advance",
          summary: "Short",
          details: "Metadata",
          final_text: "Final comment",
        },
      },
    ];
    const result = extractExecutionFromEvents(events, AGENT_ROW);
    expect(result.finalText).toBe("Final comment");
  });

  it("events with multiple finals → keeps the LAST one", () => {
    const events = [
      { type: "final", text: "first attempt", numTurns: 2, durationMs: 500 },
      { type: "sdk_event", event: {} },
      { type: "final", text: "second attempt", numTurns: 7, durationMs: 3000 },
    ];
    const result = extractExecutionFromEvents(events, AGENT_ROW);
    expect(result.finalText).toBe("second attempt");
    expect(result.numTurns).toBe(7);
    expect(result.durationMs).toBe(3000);
  });

  it("events with non-final tail → finds final from anywhere in the array", () => {
    const events = [
      { type: "sdk_event", event: {} },
      { type: "final", text: "the real answer", numTurns: 3, durationMs: 800 },
      { type: "sdk_event", event: { type: "something_after" } },
      { type: "sdk_event", event: { type: "another_event" } },
    ];
    const result = extractExecutionFromEvents(events, AGENT_ROW);
    expect(result.finalText).toBe("the real answer");
    expect(result.numTurns).toBe(3);
    expect(result.durationMs).toBe(800);
  });

  it("priorRun: null → throws TypeError", () => {
    expect(() => extractExecutionFromEvents([], null)).toThrow(TypeError);
  });

  it("priorRun: undefined → throws TypeError", () => {
    expect(() => extractExecutionFromEvents([], undefined)).toThrow(TypeError);
  });

  it("priorEvents: null → treated as empty array", () => {
    const result = extractExecutionFromEvents(null, AGENT_ROW);
    expect(result.events).toEqual([]);
    expect(result.finalText).toBe("");
  });

  it("priorEvents: non-array → treated as empty array", () => {
    const result = extractExecutionFromEvents("oops", AGENT_ROW);
    expect(result.events).toEqual([]);
  });

  it("agentName falls back to 'unknown' when agent_name is missing", () => {
    const result = extractExecutionFromEvents([], {});
    expect(result.agentName).toBe("unknown");
  });

  it("final event missing numTurns/durationMs → zero defaults", () => {
    const events = [{ type: "final", text: "output" }];
    const result = extractExecutionFromEvents(events, AGENT_ROW);
    expect(result.finalText).toBe("output");
    expect(result.numTurns).toBe(0);
    expect(result.durationMs).toBe(0);
  });

  it("events array is returned as-is (not a copy of the reversed array)", () => {
    const events = [
      { type: "sdk_event" },
      { type: "final", text: "x", numTurns: 1, durationMs: 100 },
    ];
    const result = extractExecutionFromEvents(events, AGENT_ROW);
    // The returned events must reference the same input array (not a reversed clone).
    expect(result.events).toBe(events);
  });
});
