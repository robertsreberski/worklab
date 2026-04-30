import { describe, it, expect } from "vitest";
import { nextStage, STAGES } from "../../core/state-machine.js";

// Matrix snapshot. The handful of behavior tests in state-machine.test.js cover
// individual cases; this one freezes the *full* (stage, event) → (stage, sideEffects)
// shape so an unintended reordering or dropped side-effect during refactoring
// shows up as a snapshot diff rather than silently passing the assertion-style
// tests above.

const REVIEW_DECISIONS = ["advance", "approve", "reject", "block", "pause", "delegate", "unknown"];
const NON_REVIEW_DECISIONS = ["advance", "approve", "reject", "block", "pause", "delegate", "unknown"];
const HUMAN_TARGETS = [...STAGES, "not-a-stage"];

const FIXED_SUBTASK = { title: "child", instructions: "do work" };
const FIXED_PENDING_ACTION = { command: "do thing" };

function reviewEvent(decision) {
  return {
    type: "run_succeeded",
    stage: "review",
    result: {
      decision,
      summary: "summary",
      details: "details",
      pending_actions: decision === "pause" ? [FIXED_PENDING_ACTION] : [],
      subtasks: decision === "delegate" ? [FIXED_SUBTASK] : [],
    },
    rejectionCount: 0,
    maxRejections: 3,
  };
}

function nonReviewEvent(stage, decision) {
  return {
    type: "run_succeeded",
    stage,
    result: {
      decision,
      summary: "summary",
      details: "details",
      pending_actions: decision === "pause" ? [FIXED_PENDING_ACTION] : [],
      subtasks: decision === "delegate" ? [FIXED_SUBTASK] : [],
      blocking_issues: decision === "block" ? ["needs eyes"] : [],
    },
    reviewerAgent: stage === "execute" ? "checker" : null,
  };
}

function failureEvent(failureCount = 0) {
  return {
    type: "run_failed",
    message: "boom",
    failureKind: "spawn",
    failureCount,
    maxFailures: 3,
    retryStage: "execute",
  };
}

function snapshotEntry(label, current, event) {
  return [label, current, nextStage(current, event)];
}

describe("nextStage matrix snapshot", () => {
  it("freezes run_requested behavior across all stages", () => {
    const rows = STAGES.map((stage) =>
      snapshotEntry(`run_requested|${stage}`, stage, {
        type: "run_requested",
        stage,
        mode: "execute",
        agentName: "owner",
      }),
    );
    expect(rows).toMatchSnapshot();
  });

  it("freezes review-stage decisions", () => {
    const rows = REVIEW_DECISIONS.map((decision) =>
      snapshotEntry(`review|${decision}`, "review", reviewEvent(decision)),
    );
    expect(rows).toMatchSnapshot();
  });

  it("freezes plan/execute decisions", () => {
    const rows = ["plan", "execute"].flatMap((stage) =>
      NON_REVIEW_DECISIONS.map((decision) =>
        snapshotEntry(`${stage}|${decision}`, stage, nonReviewEvent(stage, decision)),
      ),
    );
    expect(rows).toMatchSnapshot();
  });

  it("freezes failure / cancel / abandon at threshold and below", () => {
    const rows = [
      snapshotEntry("execute|run_failed|0", "execute", failureEvent(0)),
      snapshotEntry("execute|run_failed|2", "execute", failureEvent(2)),
      snapshotEntry("execute|run_cancelled|user", "execute", {
        type: "run_cancelled",
        failureKind: "cancelled_user",
        message: "user cancelled",
      }),
      snapshotEntry("execute|run_cancelled|stale", "execute", {
        type: "run_cancelled",
        failureKind: "cancelled_stale",
        message: "stale",
      }),
      snapshotEntry("execute|run_cancelled|signal", "execute", {
        type: "run_cancelled",
        failureKind: "cancelled_signal",
      }),
      snapshotEntry("execute|run_abandoned", "execute", {
        type: "run_abandoned",
        message: "coordinator restarted",
      }),
    ];
    expect(rows).toMatchSnapshot();
  });

  it("freezes children completion / blocking", () => {
    const rows = [
      snapshotEntry("awaiting_children|children_completed", "awaiting_children", { type: "children_completed" }),
      snapshotEntry("execute|children_completed", "execute", { type: "children_completed" }),
      snapshotEntry("awaiting_children|child_blocked", "awaiting_children", {
        type: "child_blocked",
        message: "blocker",
      }),
      snapshotEntry("execute|child_blocked", "execute", { type: "child_blocked", message: "blocker" }),
    ];
    expect(rows).toMatchSnapshot();
  });

  it("freezes human_move target × current cross-product", () => {
    const rows = STAGES.flatMap((current) =>
      HUMAN_TARGETS.map((target) =>
        snapshotEntry(`human_move|${current}->${target}`, current, {
          type: "human_move",
          target,
          reason: "user moved",
        }),
      ),
    );
    expect(rows).toMatchSnapshot();
  });

  it("freezes unknown event handling", () => {
    expect(nextStage("execute", { type: "what" })).toMatchSnapshot();
  });
});
