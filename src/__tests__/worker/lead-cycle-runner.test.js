import { describe, expect, it } from "vitest";
import { buildLeadSystemPrompt } from "../../worker/lead-cycle-runner.js";

describe("lead-cycle runner prompt", () => {
  it("shows same-project owned work and deletion candidates before asking for creations", () => {
    const prompt = buildLeadSystemPrompt({
      team: { name: "Path Forward V0 Team", goal: "Ship v0" },
      project: { name: "Path Forward App" },
      leadAgent: { name: "lead" },
      root: { goal_status: "in_progress" },
      members: [{ agent_name: "engineer", display_name: "Engineer", enabled: 1 }],
      children: [],
      unassignedTasks: [],
      projectTasks: [{
        id: "existing-task",
        task_key: "T-301",
        title: "Build v0 app foundation and iOS PWA shell",
        stage: "execute",
        owner_agent: "engineer",
        last_run_summary: "Foundation already planned.",
      }],
      deletableTasks: [{
        id: "lead-child",
        task_key: "T-310",
        title: "Obsolete lead split",
        stage: "execute",
        owner_agent: "engineer",
      }],
      recentCycles: [],
      maxTaskCreations: 5,
      nativeSubagents: null,
    });

    expect(prompt).toContain("## Same-project owned task roster");
    expect(prompt).toContain("[existing-task] T-301 Build v0 app foundation and iOS PWA shell");
    expect(prompt).toContain("Foundation already planned.");
    expect(prompt).toContain("## Lead-created deletion candidates");
    expect(prompt).toContain("[lead-child] T-310 Obsolete lead split");
    expect(prompt).toContain("task_deletions: array of { target_task_id, rationale }");
    expect(prompt).toContain("Do not create a task if same-project owned work already represents it.");
  });
});
