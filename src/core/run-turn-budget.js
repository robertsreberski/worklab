// Settings-backed run turn guardrail. This is intentionally not per-agent:
// team/workspace cost budgets live in the coordinator budget cascade, while
// this helper only bounds runaway tool loops by counting tool_result events.

export const DEFAULT_RUN_TURN_BUDGET = Object.freeze({
  soft: Object.freeze({ num_turns: 150 }),
  hard: Object.freeze({ num_turns: 300 }),
});

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadRunTurnBudget(settings = {}) {
  const soft = positiveInteger(settings?.agent_budget_soft_turns, DEFAULT_RUN_TURN_BUDGET.soft.num_turns);
  const hard = positiveInteger(settings?.agent_budget_hard_turns, DEFAULT_RUN_TURN_BUDGET.hard.num_turns);
  return Object.freeze({
    soft: Object.freeze({ num_turns: soft }),
    hard: Object.freeze({ num_turns: hard }),
  });
}

function reason(tier, value, cap) {
  return `${tier} budget exceeded: turns ${value} >= ${cap}`;
}

function turnReason(value, cap) {
  return [{ key: "num_turns", value, cap }];
}

export function evaluateRunTurnBudget(thresholds, stats) {
  const budget = loadRunTurnBudget({
    agent_budget_soft_turns: thresholds?.soft?.num_turns,
    agent_budget_hard_turns: thresholds?.hard?.num_turns,
  });
  const turns = Number(stats?.num_turns);
  const value = Number.isFinite(turns) ? turns : 0;
  const hardHit = value >= budget.hard.num_turns;
  const softHit = value >= budget.soft.num_turns;
  const result = {
    soft_warn: softHit,
    hard_pause: hardHit,
  };
  if (hardHit) {
    result.reason = reason("hard", value, budget.hard.num_turns);
    result.hard_reasons = turnReason(value, budget.hard.num_turns);
  } else if (softHit) {
    result.reason = reason("soft", value, budget.soft.num_turns);
    result.soft_reasons = turnReason(value, budget.soft.num_turns);
  }
  if (softHit) result.soft_reasons = result.soft_reasons || turnReason(value, budget.soft.num_turns);
  return result;
}
