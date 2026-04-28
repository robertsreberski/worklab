import { describe, expect, it } from "vitest";
import { formatRunPreviewForCopy } from "../../ui/src/routes/TaskDetail.jsx";

describe("task run preview formatting", () => {
  it("formats the system prompt and user messages for copying", () => {
    const text = formatRunPreviewForCopy({
      task_id: "task-1",
      task_key: "T-1",
      stage: "execute",
      mode: "execute",
      agent_name: "owner",
      model: "claude:claude-sonnet-4-6",
      effort: "medium",
      system_prompt: "## Role\n\nDo work.",
      messages: [{ role: "user", content: 'Work on task "Demo".' }],
    });

    expect(text).toContain("# Run input");
    expect(text).toContain("Task: T-1");
    expect(text).toContain("## System prompt\n\n## Role\n\nDo work.");
    expect(text).toContain('"role": "user"');
    expect(text).toContain('Work on task \\"Demo\\".');
  });
});
