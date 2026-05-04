import { describe, expect, it } from "vitest";
import {
  buildTranscriptTailSnapshot,
  renderResumeSnapshot,
} from "../../agent/transcript.js";

function turnEvents(seq, { thought, response, toolName, toolInput, toolResult }) {
  return [
    {
      type: "assistant",
      message: {
        content: [
          ...(thought ? [{ type: "thinking", text: thought }] : []),
          ...(response ? [{ type: "text", text: response }] : []),
          ...(toolName ? [{ type: "tool_use", id: `call_${seq}`, name: toolName, input: toolInput || {} }] : []),
        ],
      },
    },
    ...(toolName
      ? [{
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: `call_${seq}`, content: toolResult || "ok", is_error: false }],
        },
      }]
      : []),
  ];
}

describe("buildTranscriptTailSnapshot", () => {
  it("returns null when there are no events", () => {
    expect(buildTranscriptTailSnapshot([])).toBeNull();
    expect(buildTranscriptTailSnapshot(null)).toBeNull();
  });

  it("captures the last N turns with abbreviated tool results", () => {
    const events = [];
    for (let i = 1; i <= 8; i += 1) {
      events.push(...turnEvents(i, {
        thought: `thinking turn ${i}`,
        toolName: "Read",
        toolInput: { file_path: `/tmp/file-${i}.ts` },
        toolResult: `content of file ${i} `.repeat(200),
      }));
    }
    const snapshot = buildTranscriptTailSnapshot(events, { maxTurns: 3, toolResultChars: 80 });
    expect(snapshot).not.toBeNull();
    expect(snapshot.turn_count).toBe(8);
    expect(snapshot.turns).toHaveLength(3);
    const lastTurn = snapshot.turns[2];
    expect(lastTurn.tool_uses[0]).toMatchObject({ name: "Read" });
    expect(lastTurn.tool_results[0].content.length).toBeLessThanOrEqual(81);
    expect(lastTurn.thinking).toContain("thinking turn 8");
  });

  it("captures assistant text and thinking when no tool calls happen", () => {
    const events = [
      {
        type: "assistant",
        message: { content: [{ type: "thinking", text: "let me think " }, { type: "text", text: "Here's the plan." }] },
      },
      { type: "final" },
    ];
    const snapshot = buildTranscriptTailSnapshot(events);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({ assistant_text: "Here's the plan.", thinking: "let me think" });
  });

  it("renders snapshots into a structured resume_context block", () => {
    const events = turnEvents(1, {
      thought: "checking file",
      toolName: "Read",
      toolInput: { file_path: "/tmp/x.ts" },
      toolResult: "1\timport foo;\n",
    });
    const snapshot = buildTranscriptTailSnapshot(events);
    const rendered = renderResumeSnapshot(snapshot);
    expect(rendered).toContain("<resume_context>");
    expect(rendered).toContain("</resume_context>");
    expect(rendered).toContain("Tool call: Read");
    expect(rendered).toContain("Tool result: 1\timport foo;");
  });

  it("returns empty string when the snapshot is missing or empty", () => {
    expect(renderResumeSnapshot(null)).toBe("");
    expect(renderResumeSnapshot({ turns: [] })).toBe("");
  });

  it("summarises older turns into one-paragraph entries while keeping the trailing few verbatim", () => {
    const events = [];
    for (let i = 1; i <= 8; i += 1) {
      events.push(...turnEvents(i, {
        response: `assistant text turn ${i}`,
        toolName: i % 2 === 0 ? "Read" : "Bash",
        toolInput: { file_path: `/tmp/x-${i}.ts` },
        toolResult: `result for turn ${i}`,
      }));
    }
    const snapshot = buildTranscriptTailSnapshot(events, { maxTurns: 6, verbatimTurns: 2 });
    expect(snapshot.turn_count).toBe(8);
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.earlier_turn_summaries).toHaveLength(4);
    const lastSummary = snapshot.earlier_turn_summaries.at(-1);
    expect(lastSummary.turn_index).toBe(6);
    expect(lastSummary.summary).toMatch(/assistant text turn 6/);
    expect(lastSummary.summary).toMatch(/tools: Read/);
  });

  it("renderResumeSnapshot prepends the earlier-turn summaries before the verbatim turns", () => {
    const events = [];
    for (let i = 1; i <= 5; i += 1) {
      events.push(...turnEvents(i, {
        response: `step ${i}`,
        toolName: "Bash",
        toolInput: { command: `echo ${i}` },
        toolResult: `out ${i}`,
      }));
    }
    const snapshot = buildTranscriptTailSnapshot(events, { maxTurns: 5, verbatimTurns: 2 });
    const rendered = renderResumeSnapshot(snapshot);
    expect(rendered).toContain("Earlier turns (summarized)");
    expect(rendered).toMatch(/Turn 1: .*step 1/);
    expect(rendered).toMatch(/Turn 3: .*step 3/);
    expect(rendered).toContain("### Turn 4");
    expect(rendered).toContain("### Turn 5");
    expect(rendered.indexOf("Earlier turns (summarized)")).toBeLessThan(rendered.indexOf("### Turn 4"));
  });
});
