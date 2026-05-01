import { describe, expect, it } from "vitest";
import { shouldRenderTaskSubtasksCard } from "../../ui/src/routes/task-detail/WorkflowCards.jsx";

describe("task subtasks card visibility", () => {
  it("hides the child-task card when there are no child tasks", () => {
    expect(shouldRenderTaskSubtasksCard({ children: [] })).toBe(false);
    expect(shouldRenderTaskSubtasksCard({ children: null })).toBe(false);
  });

  it("shows the child-task card only for existing children", () => {
    expect(shouldRenderTaskSubtasksCard({
      children: [{ id: "child-1", title: "Child", stage: "plan" }],
    })).toBe(true);
  });
});
