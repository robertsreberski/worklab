import { describe, expect, it } from "vitest";
import { taskStageOptionsForMode } from "../../ui/src/routes/TaskEdit.jsx";

describe("task edit stage options", () => {
  it("limits new tasks to plan or execute", () => {
    expect(taskStageOptionsForMode("create").map((option) => option.value)).toEqual(["plan", "execute"]);
  });

  it("keeps all stages available while editing existing tasks", () => {
    expect(taskStageOptionsForMode("edit").map((option) => option.value)).toEqual([
      "plan",
      "execute",
      "review",
      "awaiting_children",
      "awaiting_user",
      "blocked",
      "done",
    ]);
  });
});
