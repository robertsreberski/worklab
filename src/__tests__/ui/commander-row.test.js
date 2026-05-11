import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  commanderLivePreviewEvents,
  commanderRowStagePresentation,
  commanderRunningPreviewEvents,
} from "../../ui/src/components/CommanderRow.jsx";

const commanderRowSource = readFileSync(
  resolve(import.meta.dirname, "../../ui/src/components/CommanderRow.jsx"),
  "utf8",
);
const stylesSource = readFileSync(resolve(import.meta.dirname, "../../ui/src/styles.css"), "utf8");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stylesSource.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]+)\\}`))?.groups?.body || "";
}

describe("commander row live preview", () => {
  it("keeps the workflow stage separate from running runtime state", () => {
    expect(commanderRowStagePresentation({ stage: "execute", running_run_id: "run-1" })).toEqual({
      displayStage: "execute",
      runtimeStatus: "running",
    });
    expect(commanderRowStagePresentation({
      stage: "review",
      runs: [{ id: "run-2", status: "running", process_status: "running" }],
    })).toEqual({
      displayStage: "review",
      runtimeStatus: "running",
    });
  });

  it("falls back to plan when a task has no saved stage", () => {
    expect(commanderRowStagePresentation({ running_run_id: "run-1" })).toEqual({
      displayStage: "plan",
      runtimeStatus: "running",
    });
  });

  it("encodes streaming state on the row state dot (critique §03 — stage pill removed)", () => {
    // The right-side stage pill was dropped per critique §03; stage now reads
    // from the group header + the row state-dot pulse.
    expect(commanderRowSource).toMatch(/<LivePulse\s+color=\{meta\.color\}/);
    expect(commanderRowSource).not.toMatch(/commander-cell-pill/);
  });

  it("keeps the row state dot visible after removing the stage pill", () => {
    expect(ruleBody(".commander-cell-state")).toContain("display: flex");
    expect(stylesSource).not.toContain(".commander-row > .commander-cell-state       { display: none; }");
  });

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

  it("collapses linked Edit and file_edit events in compact previews", () => {
    const preview = commanderLivePreviewEvents([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "src/app.js" } }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "file_edit:edit-1",
            name: "file_edit",
            input: {
              status: "in_progress",
              changes: [{ path: "src/app.js", kind: "update" }],
            },
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "file_edit:edit-1",
            content: {
              status: "completed",
              changes: [{
                path: "src/app.js",
                kind: "update",
                line_stats: { added_lines: 3, removed_lines: 1 },
              }],
            },
            is_error: false,
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "edit-1",
            content: "Successfully edited /workspace/src/app.js",
          }],
        },
      },
    ]);

    expect(preview).toEqual([
      {
        type: "tool_use",
        name: "file_edit",
        display_name: "Edit",
        arg: "update app.js (+3 -1)",
        status: "done",
      },
    ]);
  });
});
