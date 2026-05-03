import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import {
  formatAgentLearningContext,
  listAgentMemories,
  recordAgentMemoryCandidates,
  selectAgentLearningMemories,
} from "../../core/agent-learning.js";

function seedAgent(db, name = "coder") {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', ?, ?)
  `).run(name, name, now, now);
}

function seedTask(db, patch = {}) {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO tasks (id, task_key, project_id, root_task_id, title, instructions, stage, owner_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'execute', ?, ?, ?)
  `).run(
    patch.id || "task-1",
    patch.task_key || "T-1",
    patch.project_id || null,
    patch.id || "task-1",
    patch.title || "Task",
    patch.instructions || "Do the work.",
    patch.owner_agent || "coder",
    now,
    now,
  );
}

function seedRun(db, patch = {}) {
  db.prepare(`
    INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status)
    VALUES (?, ?, 'execute', 'execute', ?, ?, ?, 'complete', 'succeeded')
  `).run(
    patch.id || "run-1",
    patch.task_id || "task-1",
    patch.agent_name || "coder",
    patch.started_at || 1700000001000,
    patch.ended_at || 1700000002000,
  );
}

describe("agent learning memory", () => {
  it("stores structured candidates with provenance and auto-approval threshold", () => {
    const db = makeTestDb();
    seedAgent(db);
    seedTask(db);
    seedRun(db);

    const result = recordAgentMemoryCandidates(db, {
      agentName: "coder",
      projectId: null,
      taskId: "task-1",
      runId: "run-1",
      autoApproveThreshold: 0.85,
      now: 1700000003000,
      candidates: [
        {
          kind: "procedure",
          content: "For Worklab UI changes, run focused UI tests before build:ui.",
          evidence: "Run run-1 verified this path.",
          confidence: 0.9,
          scope: "agent",
        },
        {
          kind: "failure",
          content: "Skipping prompt-context tests can miss memory injection regressions.",
          evidence: "Regression caught during run run-1.",
          confidence: 0.6,
          scope: "task",
        },
      ],
    });

    expect(result.inserted).toBe(2);
    const rows = listAgentMemories(db, { agentName: "coder", limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      agent_name: "coder",
      kind: "procedure",
      status: "approved",
      task_id: "task-1",
      run_id: "run-1",
      source: "run_result",
    });
    expect(rows[1]).toMatchObject({
      kind: "failure",
      status: "draft",
      scope: "task",
    });
  });

  it("dedupes active memories by normalized content and keeps stronger evidence", () => {
    const db = makeTestDb();
    seedAgent(db);
    seedTask(db);
    seedRun(db);

    recordAgentMemoryCandidates(db, {
      agentName: "coder",
      taskId: "task-1",
      runId: "run-1",
      now: 1700000003000,
      autoApproveThreshold: 0.8,
      candidates: [{ kind: "fact", content: "Use AGENTS.md as repository guidance.", evidence: "First run", confidence: 0.7 }],
    });
    recordAgentMemoryCandidates(db, {
      agentName: "coder",
      taskId: "task-1",
      runId: "run-1",
      now: 1700000004000,
      autoApproveThreshold: 0.8,
      candidates: [{ kind: "fact", content: "  use agents.md as repository guidance.  ", evidence: "Second run", confidence: 0.95 }],
    });

    const rows = listAgentMemories(db, { agentName: "coder", limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      confidence: 0.95,
      status: "approved",
      evidence: "Second run",
      updated_at: 1700000004000,
    });
  });

  it("selects only approved memories scoped to the current task context", () => {
    const db = makeTestDb();
    seedAgent(db);
    seedAgent(db, "other");
    seedTask(db, { project_id: null });
    seedRun(db);

    recordAgentMemoryCandidates(db, {
      agentName: "coder",
      taskId: "task-1",
      runId: "run-1",
      autoApproveThreshold: 0.5,
      now: 1700000003000,
      candidates: [
        { kind: "procedure", content: "Run `npm run build:ui` after UI changes.", confidence: 0.9, scope: "agent" },
        { kind: "failure", content: "This draft should stay out of prompts.", confidence: 0.2, scope: "task" },
      ],
    });
    recordAgentMemoryCandidates(db, {
      agentName: "other",
      taskId: "task-1",
      runId: "run-1",
      autoApproveThreshold: 0.5,
      candidates: [{ kind: "procedure", content: "Other agent memory.", confidence: 0.9 }],
    });

    const memories = selectAgentLearningMemories(db, {
      agentName: "coder",
      taskId: "task-1",
      limit: 5,
    });
    expect(memories.map((memory) => memory.content)).toEqual([
      "Run `npm run build:ui` after UI changes.",
    ]);
    expect(formatAgentLearningContext(memories)).toContain("## Learned procedures");
    expect(formatAgentLearningContext(memories)).toContain("Run `npm run build:ui` after UI changes.");
    expect(formatAgentLearningContext(memories)).not.toContain("draft");
  });
});
