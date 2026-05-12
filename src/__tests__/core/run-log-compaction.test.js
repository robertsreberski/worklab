import { describe, expect, it } from "vitest";
import { compactEventForSqlite, compactEventsForSqlite } from "../../core/run-log-compaction.js";
import { extractRunArtifacts } from "../../core/run-artifacts.js";

describe("run log SQLite compaction", () => {
  it("strips full tool input and output while preserving tool identity and previews", () => {
    const event = {
      type: "sdk_event",
      event: {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/app.js", content: "x".repeat(20_000) } },
            { type: "tool_result", tool_use_id: "read-1", content: "result ".repeat(5000), is_error: false },
          ],
        },
      },
      _event_seq: 1,
    };

    const compacted = compactEventForSqlite(event);
    const [toolUse, toolResult] = compacted.event.message.content;

    expect(toolUse).toMatchObject({ type: "tool_use", id: "read-1", name: "Read", input_omitted: true });
    expect(toolUse.input).toBeUndefined();
    expect(toolUse.input_preview).toContain("file_path");
    expect(toolUse.input_omitted_bytes).toBeGreaterThan(20_000);
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "read-1", is_error: false, content_omitted: true });
    expect(toolResult.content).toBeUndefined();
    expect(toolResult.content_preview).toContain("result");
  });

  it("preserves assistant text, final worklab_result, and structured output", () => {
    const worklabResult = {
      schema: "worklab.v2",
      decision: "advance",
      summary: "Done",
      details: "Useful result",
    };
    const result = compactEventsForSqlite([
      { type: "assistant", message: { content: [{ type: "text", text: "thinking through it" }] }, _event_seq: 1 },
      { type: "structured_output", value: worklabResult, worklab_result: worklabResult, _event_seq: 2 },
      { type: "final", text: "Done", worklab_result: worklabResult, _event_seq: 3 },
    ]);

    expect(result.events).toHaveLength(3);
    expect(result.events[0].message.content[0].text).toBe("thinking through it");
    expect(result.events[1].worklab_result).toMatchObject({ schema: "worklab.v2", summary: "Done" });
    expect(result.events[2].worklab_result).toMatchObject({ decision: "advance" });
  });

  it("compacts standalone assistant worklab_result JSON before text truncation", () => {
    const worklabResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Integrated the v0 flow.",
      details: "Changed files and verified the app.",
      final_text: "Done. The v0 flow is integrated.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
      verification_evidence: [
        { kind: "test", command_or_url: "npm test", exit_code_or_status: "0", snippet: "passed".repeat(200), reason: "" },
      ],
    };

    const compacted = compactEventForSqlite({
      type: "sdk_event",
      event: {
        type: "assistant",
        message: { content: [{ type: "text", text: JSON.stringify(worklabResult) }] },
      },
      _event_seq: 12,
    }, { maxTextChars: 120 });

    expect(compacted.event).toEqual({
      type: "worklab_result_candidate",
      source: "agent_message",
      worklab_result: expect.objectContaining({
        schema: "worklab.v2",
        decision: "advance",
        final_text: "Done. The v0 flow is integrated.",
      }),
    });
  });

  it("preserves file edit metadata needed for artifact extraction", () => {
    const event = {
      type: "sdk_event",
      event: {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "file-1",
            content: {
              status: "completed",
              changes: [{
                path: "src/done.js",
                kind: "update",
                line_stats: {
                  before_lines: 2,
                  after_lines: 4,
                  added_lines: 3,
                  removed_lines: 1,
                  hunks: [{ old_start: 1, old_lines: 2, new_start: 1, new_lines: 4, content: "x".repeat(10_000) }],
                },
              }],
            },
          }],
        },
      },
      _event_seq: 5,
    };

    const compacted = compactEventForSqlite(event);
    const artifacts = extractRunArtifacts([compacted], { includePending: false, includeFailed: false });

    expect(artifacts[0]).toMatchObject({
      path: "src/done.js",
      added_lines: 3,
      removed_lines: 1,
    });
    expect(compacted.event.message.content[0].content.changes[0].line_stats.hunks[0].content).toBeUndefined();
  });

  it("can re-tail compacted events to honor a maximum log byte target", () => {
    const result = compactEventsForSqlite(
      Array.from({ length: 12 }, (_, index) => ({ type: "message", text: `event ${index}`, _event_seq: index + 1 })),
      { keepEvents: 12, maxLogBytes: 240 },
    );

    expect(result.events.length).toBeLessThan(12);
    expect(result.bytes).toBeLessThanOrEqual(240);
    expect(result.events.at(-1)._event_seq).toBe(12);
  });
});
