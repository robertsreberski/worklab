import { describe, expect, it } from "vitest";
import { formatRunPreviewForCopy } from "../../ui/src/routes/task-detail/runPreview.js";

describe("task run preview formatting", () => {
  it("formats structured run input for copying", () => {
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
      input: {
        metadata: {
          task_id: "task-1",
          task_key: "T-1",
          stage: "execute",
          mode: "execute",
          project_id: "project-1",
          project_slug: "demo-project",
          project_name: "Demo Project",
          workdir: "/tmp/demo-project",
          agent_name: "owner",
          model: "claude:claude-sonnet-4-6",
          effort: "medium",
        },
        system: { format: "markdown", content: "## Role\n\nDo work." },
        messages: [{
          role: "user",
          format: "markdown",
          content: "# Work on task\n\nTask: \"Demo\"",
        }],
        tools: [{
          name: "run_log_read",
          purpose: "Read a compact prior-run diagnostic summary on demand.",
        }],
      },
    });

    expect(text).toContain("# Run input");
    expect(text).toContain("## Metadata\n\n- Task: T-1");
    expect(text).toContain("- Project: Demo Project");
    expect(text).toContain("- Workdir: /tmp/demo-project");
    expect(text).toContain("## System message\n\n- Format: markdown");
    expect(text).toContain("```markdown\n## Role\n\nDo work.\n```");
    expect(text).toContain("## User messages");
    expect(text).toContain("### user message 1");
    expect(text).not.toContain('Work on task \\"Demo\\".');
    expect(text).toContain("# Work on task\n\nTask: \"Demo\"");
    expect(text).toContain("## On-demand tools\n\n- `run_log_read`: Read a compact prior-run diagnostic summary on demand.");
  });
});
