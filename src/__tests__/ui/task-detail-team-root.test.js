import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const taskDetailSourcePath = resolve(import.meta.dirname, "../../ui/src/routes/TaskDetail.jsx");

describe("TaskDetail team-root controls", () => {
  it("uses lead-cycle copy and hides normal run preview for synthetic team roots", () => {
    const source = readFileSync(taskDetailSourcePath, "utf8");

    expect(source).toContain('label: "Run lead cycle"');
    expect(source).toContain("task?.is_team_root");
    expect(source).toContain("!task?.is_team_root");
    expect(source).toContain("Lead cycle runs coordinate the team roster");
  });
});
