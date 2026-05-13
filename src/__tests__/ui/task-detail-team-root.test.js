import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const taskDetailSourcePath = resolve(import.meta.dirname, "../../ui/src/routes/TaskDetail.jsx");
const taskEditSourcePath = resolve(import.meta.dirname, "../../ui/src/routes/TaskEdit.jsx");

describe("TaskDetail team-root controls", () => {
  it("uses lead-cycle copy and hides normal run preview for synthetic team roots", () => {
    const source = readFileSync(taskDetailSourcePath, "utf8");

    expect(source).toContain('label: "Run lead cycle"');
    expect(source).toContain("task?.is_team_root");
    expect(source).toContain("const canEditTask = task && !isTeamRoot");
    expect(source).toContain("const canChangeTaskStatus = task && !isTeamRoot");
    expect(source).toContain("readOnly={isTeamRoot}");
    expect(source).toContain("Lead cycle runs coordinate the team roster");
  });

  it("uses a short project-scoped goal badge label for synthetic team roots", () => {
    const source = readFileSync(taskDetailSourcePath, "utf8");

    expect(source).toContain("taskGoalBadgeLabel");
    expect(source).toContain("taskGoalBadgeTitle");
    expect(source).toContain("label={taskGoalBadgeLabel}");
    expect(source).toContain("title={taskGoalBadgeTitle}");
    expect(source).not.toContain('label={task.goal_contract?.objective || "Unknown"}');
  });

  it("blocks direct edit-mode changes for synthetic team roots", () => {
    const source = readFileSync(taskEditSourcePath, "utf8");

    expect(source).toContain("Boolean(loadedTask?.is_team_root)");
    expect(source).toContain("Lead cycle anchors are edited from Goals.");
    expect(source).toContain("Open goal");
  });
});
