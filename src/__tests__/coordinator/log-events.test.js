import { describe, expect, it } from "vitest";

import { truncateDisplayEvent } from "../../coordinator/spawn-worker/log-events.js";

describe("coordinator display-event truncation", () => {
  it.each(["content", "output", "result"])(
    "bounds structured tool-result %s values",
    (field) => {
      const event = {
        type: "assistant",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            [field]: { nested: { payload: "x".repeat(500) } },
          }],
        },
      };

      const truncated = truncateDisplayEvent(event, {
        limit: 100,
        rawLogPath: "/tmp/worklab-run.jsonl",
      });
      const block = truncated.message.content[0];

      expect(block[field]).toMatchObject({
        truncated: true,
        raw_output_path: "/tmp/worklab-run.jsonl",
      });
      expect(block[field].original_length).toBeGreaterThan(100);
      expect(block[field].preview).toContain("full raw log available");
      expect(block).toMatchObject({
        truncated: true,
        raw_output_path: "/tmp/worklab-run.jsonl",
      });
      expect(block.original_length).toBeGreaterThan(100);
    },
  );

  it("preserves bounded structured tool results", () => {
    const value = { ok: true, rows: [1, 2, 3] };
    const event = {
      type: "assistant",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: value,
        }],
      },
    };

    expect(truncateDisplayEvent(event, { limit: 1_000, rawLogPath: "/tmp/run.jsonl" }))
      .toEqual(event);
  });
});
