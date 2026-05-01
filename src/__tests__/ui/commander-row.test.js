import { describe, expect, it } from "vitest";
import { commanderLivePreviewEvents, commanderRunningPreviewEvents } from "../../ui/src/components/CommanderRow.jsx";

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

  it("coalesces consecutive text fragments", () => {
    const preview = commanderLivePreviewEvents([
      { type: "assistant", message: { content: [{ type: "text", text: "Lo" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "ading" }] } },
    ]);

    expect(preview).toEqual([
      { type: "text", text: "Loading" },
    ]);
  });

  it("replaces streamed text fragments with a completed snapshot", () => {
    const fullText = "Checking output and preparing the next edit.";
    const preview = commanderLivePreviewEvents([
      { type: "text", text: "Checking output" },
      { type: "text", text: " and preparing" },
      { type: "text", text: fullText },
    ]);

    expect(preview).toEqual([
      { type: "text", text: fullText },
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

  it("uses compact progress events for running row previews", () => {
    const preview = commanderRunningPreviewEvents({
      id: "task-1",
      running_run_id: "run-1",
      running_run: { id: "run-1", last_event: { type: "text", text: "hydrated", _event_seq: 1 } },
    }, [
      { type: "text", text: "live", _event_seq: 2 },
      { type: "tool_use", name: "read", input: { file: "b.js" }, _event_seq: 3 },
    ]);

    expect(preview).toEqual([
      { type: "text", text: "hydratedlive", _event_seq: 1 },
      { type: "tool_use", name: "read", input: { file: "b.js" }, _event_seq: 3, arg: "{\"file\":\"b.js\"}" },
    ]);
  });
});
