import { describe, expect, it } from "vitest";
import {
  buildKnowledgePromotionHash,
  groupProjectKnowledgeEntries,
  recentProjectTaskOutputs,
} from "../../ui/src/lib/projectKnowledge.js";

describe("project knowledge helpers", () => {
  it("groups canonical knowledge by category and hides auto-promoted run assets", () => {
    const grouped = groupProjectKnowledgeEntries([
      { slug: "run-auto", title: "Run auto", category: "run-results", auto_promoted: true },
      { slug: "runbook", title: "Runbook", category: "runbook", updated_at: "2026-05-04T00:00:00Z" },
      { slug: "decision", title: "Decision", category: "decision", updated_at: "2026-05-05T00:00:00Z" },
      { slug: "research", title: "Research", category: "research", pinned: true, updated_at: "2026-05-01T00:00:00Z" },
    ]);

    expect(grouped.map((group) => [group.key, group.entries.map((entry) => entry.slug)])).toEqual([
      ["research", ["research"]],
      ["decision", ["decision"]],
      ["runbook", ["runbook"]],
    ]);
  });

  it("selects recent task outputs separately from canonical knowledge", () => {
    const outputs = recentProjectTaskOutputs([
      { id: "no-output", title: "No output", stage: "done" },
      {
        id: "task-1",
        task_key: "T-1",
        title: "Build",
        updated_at: 2,
        last_run: {
          id: "run-1",
          process_status: "succeeded",
          summary: "Built the feature.",
          details: "",
          artifact_summary: { files: 2 },
          ended_at: 10,
        },
      },
      {
        id: "task-2",
        task_key: "T-2",
        title: "Research",
        updated_at: 3,
        last_run: {
          id: "run-2",
          process_status: "succeeded",
          summary: "Found the answer.",
          details: "Longer note.",
          artifact_summary: { files: 0 },
          ended_at: 20,
        },
      },
    ]);

    expect(outputs.map((output) => output.task_key)).toEqual(["T-2", "T-1"]);
    expect(outputs[1].artifact_label).toBe("2 files");
  });

  it("ignores tasks with an explicit null last run", () => {
    expect(recentProjectTaskOutputs([
      { id: "never-run", task_key: "T-0", title: "Never run", last_run: null },
    ])).toEqual([]);
  });

  it("builds a project-scoped promotion URL with source metadata", () => {
    const hash = buildKnowledgePromotionHash({
      project: { id: "project-1", slug: "project-one" },
      taskOutput: {
        task_id: "task-1",
        task_key: "T-1",
        title: "Build",
        run_id: "run-1",
        agent_name: "coder",
        summary: "Built the feature.",
      },
    });

    expect(hash).toContain("#/knowledge/new?");
    const params = new URLSearchParams(hash.split("?")[1]);
    expect(params.get("project_id")).toBe("project-1");
    expect(params.get("source_task_id")).toBe("task-1");
    expect(params.get("source_task_key")).toBe("T-1");
    expect(params.get("source_run_id")).toBe("run-1");
    expect(params.get("source_agent")).toBe("coder");
    expect(params.get("category")).toBe("research");
    expect(params.get("body")).toContain("[T-1](#/tasks/T-1)");
  });
});
