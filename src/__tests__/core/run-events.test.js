import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { buildRunLifecycleEvent, tailRunEventsByVisibleItems } from "../../core/run-events.js";

function seedAgent(db, name = "coder") {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(name, "Code Specialist", "claude", "claude:claude-sonnet-4-6", now, now);
}

describe("run lifecycle events", () => {
  it("builds task run metadata from the database", () => {
    const db = makeTestDb();
    seedAgent(db);
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, task_key, root_task_id, title, stage, owner_agent, created_at, updated_at)
      VALUES ('task-1', 'T-7', 'task-1', 'Implement notifications', 'execute', 'coder', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO task_runs
        (id, task_id, mode, stage, agent_name, status, process_status, failure_kind, error_text, started_at, ended_at)
      VALUES ('run-1', 'task-1', 'execute', 'execute', 'coder', 'error', 'failed', 'spawn', 'worker exited', ?, ?)
    `).run(now - 1000, now);

    expect(buildRunLifecycleEvent(db, "run_ended", "run-1")).toEqual({
      type: "run_ended",
      runId: "run-1",
      taskId: "task-1",
      taskKey: "T-7",
      taskTitle: "Implement notifications",
      mode: "execute",
      stage: "execute",
      agentName: "coder",
      agentDisplayName: "Code Specialist",
      status: "error",
      processStatus: "failed",
      failureKind: "spawn",
      errorText: "worker exited",
      startedAt: now - 1000,
      endedAt: now,
    });
  });

});

describe("run event visible tail", () => {
  function thinkingEvent(seq, text = `thought ${seq} `) {
    return {
      type: "assistant",
      message: { content: [{ type: "thinking", text }] },
      _event_seq: seq,
    };
  }

  function textEvent(seq, text = `event ${seq}`) {
    return { type: "text", text, _event_seq: seq };
  }

  it("counts streamed thinking chunks as one visible tail item", () => {
    const events = [
      ...Array.from({ length: 20 }, (_, index) => thinkingEvent(index + 1)),
      ...Array.from({ length: 5 }, (_, index) => textEvent(index + 21)),
    ];

    const tail = tailRunEventsByVisibleItems(events, 10);

    expect(tail.map((event) => event._event_seq)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it("counts a completed thinking snapshot after streamed fragments as one visible tail item", () => {
    const fullText = "checking files and preparing the implementation";
    const events = [
      thinkingEvent(1, "checking files "),
      thinkingEvent(2, "and preparing "),
      thinkingEvent(3, fullText),
      ...Array.from({ length: 9 }, (_, index) => textEvent(index + 4)),
    ];

    const tail = tailRunEventsByVisibleItems(events, 10);

    expect(tail.map((event) => event._event_seq)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  it("keeps tool calls atomic while coalescing adjacent thinking items", () => {
    const events = [
      textEvent(1, "old"),
      { type: "tool_use", tool_use_id: "tool-1", name: "Bash", input: { cmd: "npm test" }, _event_seq: 2 },
      ...Array.from({ length: 12 }, (_, index) => thinkingEvent(index + 3)),
      ...Array.from({ length: 8 }, (_, index) => textEvent(index + 15)),
      { type: "tool_result", tool_use_id: "tool-1", output: "ok", is_error: false, _event_seq: 23 },
    ];

    const tail = tailRunEventsByVisibleItems(events, 10);

    expect(tail.map((event) => event._event_seq)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
      15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
  });
});
