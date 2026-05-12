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

  it("frames lead cycles as project overview passes with end vision and refinement context", () => {
    const prompt = buildLeadSystemPrompt({
      team: { name: "Path Forward V0 Team", goal: "Ship v0" },
      project: {
        name: "Path Forward App",
        description: "An agent-native planning surface.",
        context: "The current app must feel native, not like a task factory.",
        workdir: "/repo/path-forward",
      },
      leadAgent: { name: "lead" },
      root: { goal_status: "in_progress" },
      goalContract: {
        north_star: "A polished autonomous project cockpit.",
        objective: "Ship Path Forward v0 with native goals and lead cycles.",
        stopping_condition: "Users can trust the lead cycle overview.",
        validation_loop: "Run UI and coordinator tests.",
        constraints: ["Do not duplicate already planned work."],
        links: [{ label: "Design brief", url: "https://example.test/brief" }],
      },
      repositoryInstructions: {
        path: "/repo/path-forward/AGENTS.md",
        content: "Use existing Worklab module boundaries.",
        truncated: false,
      },
      effectiveWorkdir: "/repo/path-forward",
      members: [{ agent_name: "engineer", display_name: "Engineer", enabled: 1 }],
      children: [],
      unassignedTasks: [],
      projectTasks: [{
        id: "existing-task",
        task_key: "T-301",
        title: "Build v0 app foundation and iOS PWA shell",
        stage: "execute",
        owner_agent: "engineer",
        instructions: "Already owns app foundation and shell work.",
        plan_body: "Plan: implement native routing and shell polish.",
        last_run_summary: "Foundation already planned.",
      }],
      deletableTasks: [],
      recentCycles: [],
      maxTaskCreations: 5,
      nativeSubagents: null,
    });

    expect(prompt).toContain("## Project overview and end vision");
    expect(prompt).toContain("North star: A polished autonomous project cockpit.");
    expect(prompt).toContain("Objective: Ship Path Forward v0 with native goals and lead cycles.");
    expect(prompt).toContain("Done when: Users can trust the lead cycle overview.");
    expect(prompt).toContain("Validate with: Run UI and coordinator tests.");
    expect(prompt).toContain("The current app must feel native, not like a task factory.");
    expect(prompt).toContain("## Repository instructions");
    expect(prompt).toContain("/repo/path-forward/AGENTS.md");
    expect(prompt).toContain("Use existing Worklab module boundaries.");
    expect(prompt).toContain("Already owns app foundation and shell work.");
    expect(prompt).toContain("Plan: implement native routing and shell polish.");
    expect(prompt).toContain("Lead cycles are project overview passes first; task changes are only gap-closing actions.");
    expect(prompt).toContain("goal_refinement: { mode, confidence, compatible_expansion, rationale, patch }");
    expect(prompt).toContain("Only propose mode=\"apply\" when the refinement is a high-confidence compatible expansion of the current goal.");
  });
});
