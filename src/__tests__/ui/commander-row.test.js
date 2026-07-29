import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  commanderChildTaskLabel,
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

  it("keeps workflow stage visible as a right-side StageToken", () => {
    expect(commanderRowSource).toContain("StageToken");
    expect(commanderRowSource).toMatch(/<StageToken\s+stage=\{displayStage\}/);
    expect(commanderRowSource).toContain("commander-cell-pill");
    expect(commanderRowSource).not.toContain("CommanderInlineMeta");
  });

  it("uses sans operational typography for task titles", () => {
    expect(commanderRowSource).not.toContain('class="commander-title h-entity"');
    expect(ruleBody(".commander-title")).toContain("font-weight: 600");
    expect(ruleBody(".commander-title")).not.toContain("font-family: var(--font-display)");
  });

  it("labels child tasks by their parent key", () => {
    expect(commanderChildTaskLabel({
      parent_task_id: "parent-1",
      parent: { task_key: "T-42", title: "Parent task" },
    })).toBe("Child of T-42");
    expect(commanderChildTaskLabel({ parent_task_id: "parent-1" })).toBe("Child task");
    expect(commanderChildTaskLabel({ id: "standalone" })).toBe(null);
  });

  it("renders child task hierarchy as a commander title-row chip", () => {
    expect(commanderRowSource).toContain("commander-child-chip");
    expect(commanderRowSource).toContain("commanderChildTaskLabel(task)");
    expect(ruleBody(".commander-child-chip")).toContain("max-width");
    expect(ruleBody(".commander-child-chip")).toContain("white-space: nowrap");
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

  it("shows a single thinking row for redacted thinking and progress estimates", () => {
    const preview = commanderLivePreviewEvents([
      { type: "thinking_progress", estimated_tokens: 50, estimated_tokens_delta: 50 },
      { type: "thinking_progress", estimated_tokens: 300, estimated_tokens_delta: 250 },
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 300 }] } },
    ]);

    expect(preview).toEqual([
      { type: "thinking", text: "Thinking… ~300 tokens", redacted: true, estimated_tokens: 300 },
    ]);
  });

  it("labels historical redacted thinking blocks that carry no token estimate", () => {
    const preview = commanderLivePreviewEvents([
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "sig-1" }] } },
    ]);

    expect(preview).toEqual([
      { type: "thinking", text: "Thinking…", thinking: "", signature: "sig-1", redacted: true },
    ]);
  });

  it("lets a redacted marker supersede the preceding thinking preview", () => {
    const preview = commanderLivePreviewEvents([
      { type: "thinking", text: "Reading the coalescer" },
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 120 }] } },
    ]);

    expect(preview).toEqual([
      { type: "thinking", text: "Thinking… ~120 tokens", redacted: true, estimated_tokens: 120 },
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
