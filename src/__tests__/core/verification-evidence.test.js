import { describe, expect, it } from "vitest";
import { crossCheckVerificationEvidence } from "../../core/verification-evidence.js";
import { makeTestDb } from "../helpers/test-db.js";

function seedRunWithEvents(db, runId, events) {
  const now = Date.now();
  db.prepare("INSERT INTO task_runs (id, mode, agent_name, started_at, status) VALUES (?, 'review', 'reviewer', ?, 'succeeded')")
    .run(runId, now);
  db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES (?, ?, ?, 'complete', ?)")
    .run(`log-${runId}`, runId, JSON.stringify(events), now);
}

describe("crossCheckVerificationEvidence", () => {
  it("returns zeros when there is no evidence", () => {
    const db = makeTestDb();
    const result = crossCheckVerificationEvidence(db, { reviewRunId: "r1", evidence: [] });
    expect(result).toEqual({ totalChecked: 0, matchedCount: 0, unmatchedCount: 0 });
  });

  it("treats kind='n_a' rows as documentation, not as something to cross-check", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "r1", []);
    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "r1",
      evidence: [{ kind: "n_a", reason: "research only" }],
    });
    expect(result).toEqual({ totalChecked: 0, matchedCount: 0, unmatchedCount: 0 });
  });

  it("matches evidence command against tool_use input across the run + parent run", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", [
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test src/foo" } }] },
        },
      },
    ]);
    seedRunWithEvents(db, "exec-1", [
      {
        type: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm run build" } }],
      },
    ]);
    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      parentRunId: "exec-1",
      evidence: [
        { kind: "test", command_or_url: "npm test src/foo" },
        { kind: "build", command_or_url: "npm run build" },
        { kind: "lint", command_or_url: "npm run lint" },
      ],
    });
    expect(result.totalChecked).toBe(3);
    expect(result.matchedCount).toBe(2);
    expect(result.unmatchedCount).toBe(1);
  });

  it("reports all unmatched when the run has no tool calls at all", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", []);
    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      evidence: [{ kind: "test", command_or_url: "npm test" }],
    });
    expect(result.totalChecked).toBe(1);
    expect(result.matchedCount).toBe(0);
    expect(result.unmatchedCount).toBe(1);
  });

  it("counts evidence with no command_or_url as unmatched (no way to verify)", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", [
      { type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] },
    ]);
    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      evidence: [{ kind: "test" }],
    });
    expect(result.unmatchedCount).toBe(1);
  });
});
