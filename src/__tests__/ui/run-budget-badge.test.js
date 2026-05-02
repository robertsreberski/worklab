import { describe, expect, it } from "vitest";
import { runBudgetBadgeState } from "../../ui/src/routes/task-detail/RunCards.jsx";

describe("run budget badge state", () => {
  it("labels successful per-run budget overages without calling them cancellations", () => {
    expect(runBudgetBadgeState({
      process_status: "succeeded",
      failure_kind: null,
      warnings: [{ kind: "budget_exceeded", source: "budget", message: "Run cost exceeded per-run budget." }],
    })).toMatchObject({
      label: "Budget over",
      tone: "run-warning-budget-soft",
    });
  });

  it("labels actual budget cancellations as budget cancels", () => {
    expect(runBudgetBadgeState({
      process_status: "cancelled",
      failure_kind: "budget_exceeded",
      cancel_initiator: "budget",
      warnings: [{ kind: "budget_exceeded", source: "budget", message: "Run cancelled.", diagnostics: { tier: "hard" } }],
    })).toMatchObject({
      label: "Budget cancel",
      tone: "run-warning-budget-hard",
    });
  });
});
