import { describe, expect, it } from "vitest";
import { normalizeWorklabEvents } from "../../ui/src/components/EventTimeline.jsx";
import { normalizeToolTokenEvent } from "../../ui/src/components/primitives/ToolToken.jsx";
import { mergeRunEvents } from "../../ui/src/lib/useRunStream.js";

describe("worklab event timeline normalization", () => {
  it("compacts final result payloads after visible assistant text", () => {
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "Done." }] },
        },
      },
      {
        type: "final",
        text: "Done.",
        model: "model-a",
        usage: { input_tokens: 10, output_tokens: 3 },
        durationMs: 500,
        numTurns: 1,
      },
    ]);

    expect(events[0].message.content[0].text).toBe("Done.");
    expect(events[1]).toMatchObject({
      type: "final",
      compact: true,
      text: "Done.",
      model: "model-a",
      durationMs: 500,
      numTurns: 1,
    });
  });

  it("keeps final text visible when no assistant text event was recorded", () => {
    const events = normalizeWorklabEvents([
      { type: "started" },
      {
        type: "final",
        text: "Only final text.",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);

    expect(events[1]).toEqual({
      type: "final",
      text: "Only final text.\n\nin 1 / out 2",
    });
  });

  it("uses worklab_result summary for visible final rows", () => {
    const events = normalizeWorklabEvents([
      {
        type: "final",
        text: "{\"schema\":\"worklab.v2\"}",
        worklab_result: { summary: "Short result", details: "Useful detail" },
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);

    expect(events[0]).toEqual({
      type: "final",
      text: "Short result\n\nUseful detail\n\nin 1 / out 2",
      structured: { summary: "Short result", details: "Useful detail" },
    });
  });

  it("hides noisy CLI housekeeping events and keeps runtime warnings readable", () => {
    const events = normalizeWorklabEvents([
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "hook_started", hook: "PreToolUse" } } },
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "system", subtype: "init" } } },
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "turn_failed", message: "bad" } } },
      { type: "runtime_warning", warning_kind: "unstructured_result_fallback", message: "final text is not JSON" },
    ]);

    expect(events).toEqual([
      { type: "cli_event", raw: { type: "turn_failed", message: "bad" } },
      { type: "runtime_warning", warning_kind: "unstructured_result_fallback", message: "final text is not JSON" },
    ]);
  });
});

describe("run event merging", () => {
  it("deduplicates hydrated and streamed events by sequence", () => {
    const merged = mergeRunEvents(
      [{ type: "text", text: "two", _event_seq: 2 }],
      [
        { type: "text", text: "one", _event_seq: 1 },
        { type: "text", text: "two updated", _event_seq: 2 },
      ],
    );

    expect(merged).toEqual([
      { type: "text", text: "one", _event_seq: 1 },
      { type: "text", text: "two updated", _event_seq: 2 },
    ]);
  });
});

describe("compact run event labels", () => {
  it("unwraps sdk assistant text for list-row display", () => {
    expect(
      normalizeToolTokenEvent({
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "Checking files" }] },
        },
      }),
    ).toEqual({ type: "text", text: "Checking files" });
  });

  it("uses final worklab result summary when present", () => {
    expect(
      normalizeToolTokenEvent({
        type: "final",
        text: "long final text",
        worklab_result: { summary: "Short outcome" },
      }),
    ).toEqual({ type: "text", text: "Short outcome" });
  });
});
