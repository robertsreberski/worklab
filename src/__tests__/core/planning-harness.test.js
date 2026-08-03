import { describe, expect, it } from "vitest";
import { WORKLAB_BUILTIN_TOOLS } from "../../core/builtin-tools.js";
import { applyPlanningToolPolicy } from "../../core/planning-harness.js";

const PLANNING_HELPER_TOOLS = ["Agent", "Task", "TaskOutput", "TaskStop", "Skill"];
const READ_ONLY_CHILD_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];

describe("applyPlanningToolPolicy", () => {
  it("keeps delegation and skills available in no-shell read-only planning", () => {
    const result = applyPlanningToolPolicy({
      mode: "plan",
      settings: { planning_tool_policy: "read_only_no_shell" },
      allowedTools: [...WORKLAB_BUILTIN_TOOLS],
      disallowedTools: [],
    });

    expect(result.allowedTools).toEqual([...READ_ONLY_CHILD_TOOLS, ...PLANNING_HELPER_TOOLS]);
    expect(result.allowedTools).not.toContain("Bash");
    expect(result.allowedTools).not.toContain("Write");
    expect(result.allowedTools).not.toContain("Edit");
    expect(result.disallowedTools).toEqual(["Write", "Edit", "Bash"]);
  });

  it("keeps delegation and skills beside read-only Bash planning", () => {
    const result = applyPlanningToolPolicy({
      mode: "plan",
      settings: { planning_tool_policy: "read_only_shell_allowlist" },
      allowedTools: [...WORKLAB_BUILTIN_TOOLS],
      disallowedTools: [],
    });

    expect(result.allowedTools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Bash",
      "WebFetch",
      "WebSearch",
      ...PLANNING_HELPER_TOOLS,
    ]);
    expect(result.disallowedTools).toEqual(["Write", "Edit"]);
    expect(result.toolPolicy).toMatchObject({ planning: true, bashReadOnly: true });
  });

  it("does not add planning entry tools the parent policy withheld", () => {
    const result = applyPlanningToolPolicy({
      mode: "plan",
      settings: { planning_tool_policy: "read_only_no_shell" },
      allowedTools: ["Read", "Agent", "TaskOutput", "Write"],
      disallowedTools: [],
    });

    expect(result.allowedTools).toEqual(["Read", "Agent", "TaskOutput"]);
    expect(result.allowedTools).not.toContain("Task");
    expect(result.allowedTools).not.toContain("TaskStop");
    expect(result.allowedTools).not.toContain("Skill");
  });
});
