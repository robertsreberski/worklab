import { describe, expect, it } from "vitest";
import {
  isPendingQuestionAnswered,
  shouldRenderTaskPendingQuestionsCard,
  shouldRenderTaskSubtasksCard,
} from "../../ui/src/routes/task-detail/WorkflowCards.jsx";

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

describe("task pending questions card visibility", () => {
  const question = {
    id: "scope",
    question: "Which scope?",
    options: [{ id: "small", label: "Small" }, { id: "full", label: "Full" }],
  };

  it("shows only when an awaiting-user task has pending questions", () => {
    expect(shouldRenderTaskPendingQuestionsCard({ stage: "awaiting_user", pending_questions: [question] })).toBe(true);
    expect(shouldRenderTaskPendingQuestionsCard({ stage: "plan", pending_questions: [question] })).toBe(false);
    expect(shouldRenderTaskPendingQuestionsCard({ stage: "awaiting_user", pending_questions: [] })).toBe(false);
  });

  it("checks single, multi, and free-text answers", () => {
    expect(isPendingQuestionAnswered(question, { selected: ["full"] })).toBe(true);
    expect(isPendingQuestionAnswered(question, { selected: [] })).toBe(false);
    expect(isPendingQuestionAnswered({ ...question, multi_select: true }, { selected: ["small", "full"] })).toBe(true);
    expect(isPendingQuestionAnswered({ ...question, allow_free_text: true }, { selected: [], text: "Use the safest default." })).toBe(true);
  });
});
