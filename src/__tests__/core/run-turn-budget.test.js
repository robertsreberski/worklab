import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUN_TURN_BUDGET,
  evaluateRunTurnBudget,
  loadRunTurnBudget,
} from "../../core/run-turn-budget.js";

describe("loadRunTurnBudget", () => {
  it("uses default settings-backed turn thresholds", () => {
    expect(loadRunTurnBudget()).toEqual(DEFAULT_RUN_TURN_BUDGET);
  });

  it("uses saved turn settings without adding cost or duration caps", () => {
    const budget = loadRunTurnBudget({
      agent_budget_soft_turns: 40,
      agent_budget_hard_turns: 80,
    });
    expect(budget).toEqual({
      soft: { num_turns: 40 },
      hard: { num_turns: 80 },
    });
    expect(budget.soft).not.toHaveProperty("cost_usd");
    expect(budget.soft).not.toHaveProperty("duration_ms");
  });

  it("falls back to defaults for invalid settings", () => {
    expect(loadRunTurnBudget({
      agent_budget_soft_turns: 0,
      agent_budget_hard_turns: "nope",
    })).toEqual(DEFAULT_RUN_TURN_BUDGET);
  });
});

describe("evaluateRunTurnBudget", () => {
  const budget = loadRunTurnBudget({ agent_budget_soft_turns: 2, agent_budget_hard_turns: 4 });

  it("returns no warnings below the soft threshold", () => {
    const result = evaluateRunTurnBudget(budget, { num_turns: 1, cost_usd: 999, duration_ms: 999_999 });
    expect(result.soft_warn).toBe(false);
    expect(result.hard_pause).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("warns at the soft threshold", () => {
    const result = evaluateRunTurnBudget(budget, { num_turns: 2 });
    expect(result.soft_warn).toBe(true);
    expect(result.hard_pause).toBe(false);
    expect(result.reason).toContain("soft budget exceeded");
    expect(result.soft_reasons).toEqual([{ key: "num_turns", value: 2, cap: 2 }]);
  });

  it("pauses at the hard threshold", () => {
    const result = evaluateRunTurnBudget(budget, { num_turns: 4 });
    expect(result.soft_warn).toBe(true);
    expect(result.hard_pause).toBe(true);
    expect(result.reason).toContain("hard budget exceeded");
    expect(result.hard_reasons).toEqual([{ key: "num_turns", value: 4, cap: 4 }]);
  });
});
