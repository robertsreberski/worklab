import { describe, expect, it } from "vitest";
import { commanderLivePreviewEvents } from "../../ui/src/components/CommanderRow.jsx";

describe("commander row live preview", () => {
  it("coalesces consecutive thinking fragments", () => {
    const preview = commanderLivePreviewEvents([
      { type: "assistant", message: { content: [{ type: "thinking", text: "Looking " }] } },
      { type: "assistant", message: { content: [{ type: "thinking", text: "at files" }] } },
    ]);

    expect(preview).toEqual([
      { type: "thinking", text: "Looking at files" },
    ]);
  });

  it("replaces streamed thinking fragments with a completed snapshot", () => {
    const fullText = "Checking output and preparing the next edit.";
    const preview = commanderLivePreviewEvents([
      { type: "thinking", text: "Checking output" },
      { type: "thinking", text: " and preparing" },
      { type: "thinking", text: fullText },
    ]);

    expect(preview).toEqual([
      { type: "thinking", text: fullText },
    ]);
  });

  it("limits the preview to the latest two events", () => {
    const preview = commanderLivePreviewEvents([
      { type: "text", text: "first" },
      { type: "tool_use", name: "read", input: { file: "a.js" } },
      { type: "text", text: "latest" },
    ]);

    expect(preview).toEqual([
      { type: "tool_use", name: "read", input: { file: "a.js" }, arg: "{\"file\":\"a.js\"}" },
      { type: "text", text: "latest" },
    ]);
  });
});
