import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");

function source(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("team selector wiring", () => {
  it("uses agent pickers for team lead and member agents", () => {
    const teamsSource = source("src/ui/src/routes/Teams.jsx");

    expect(teamsSource).toContain("AgentPicker");
    expect(teamsSource).not.toContain("placeholder=\"agent name\"");
    expect(teamsSource).not.toContain("placeholder=\"agent name (must be enabled)\"");
  });

  it("uses a team picker for project and task team assignment", () => {
    const projectsSource = source("src/ui/src/routes/Projects.jsx");
    const taskEditSource = source("src/ui/src/routes/TaskEdit.jsx");

    expect(projectsSource).toContain("TeamPicker");
    expect(projectsSource).not.toContain("Team id or slug");
    expect(taskEditSource).toContain("TeamPicker");
    expect(taskEditSource).toContain("team_id");
  });
});
