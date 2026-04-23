import { describe, expect, it } from "vitest";
import { normalizeWorklabEvents } from "../../ui/src/components/EventTimeline.jsx";

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
});
