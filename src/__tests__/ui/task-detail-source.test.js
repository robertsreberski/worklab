import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const taskDetailSource = readFileSync(
  resolve(import.meta.dirname, "../../ui/src/routes/TaskDetail.jsx"),
  "utf8",
);

describe("TaskDetail team metadata", () => {
  it("renders the resolved team display name instead of the raw canonical id", () => {
    expect(taskDetailSource).toContain("taskTeamDisplay");
    expect(taskDetailSource).toContain("task?.team?.name");
    expect(taskDetailSource).not.toContain('label={task.team_id}');
  });
});
