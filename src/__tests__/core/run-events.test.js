import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import {
  ACP_LEGACY_STREAM_EVENT_LIMIT,
  buildRunLifecycleEvent,
  SUBAGENT_ACTIVITY_ROW_LIMIT,
  tailRunEventsByVisibleItems,
} from "../../core/run-events.js";

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

  it("keeps ACP streams and raw-companion pairs atomic in a bounded tail", () => {
    let sequence = 0;
    const sdkEvent = (event) => ({ type: "sdk_event", event, _event_seq: ++sequence });
    const acpUpdate = (update) => sdkEvent({
      type: "acp_session_update",
      sessionId: "session-private",
      update,
    });
    const assistantCompanion = (content) => sdkEvent({
      type: "assistant",
      message: { content },
    });
    const privatePairingSentinel = "PRIVATE_ACP_PAIRING_SENTINEL";

    const oldMessageRaw = acpUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-old",
      content: { type: "text", text: "Old" },
    });
    const oldMessageCompanion = assistantCompanion([{ type: "text", text: "Old" }]);
    const oldText = textEvent(++sequence, "old standalone row");

    const messageRawOne = acpUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-current",
      content: { type: "text", text: "Current " },
    });
    const messageCompanionOne = assistantCompanion([{ type: "text", text: "Current " }]);
    const messageRawTwo = acpUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "message-current",
      content: { type: "text", text: "message" },
    });
    const messageCompanionTwo = assistantCompanion([{ type: "text", text: "message" }]);
    const selectedMessageStream = [
      messageRawOne,
      messageCompanionOne,
      messageRawTwo,
      messageCompanionTwo,
    ];

    const thoughtRawOne = acpUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "private thought one" },
    });
    const thoughtCompanionOne = assistantCompanion([{
      type: "thinking",
      thinking: "private thought one",
    }]);
    const thoughtRawTwo = acpUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "private thought two" },
    });
    const thoughtCompanionTwo = assistantCompanion([{
      type: "thinking",
      thinking: "private thought two",
    }]);
    const selectedThoughtStream = [
      thoughtRawOne,
      thoughtCompanionOne,
      thoughtRawTwo,
      thoughtCompanionTwo,
    ];

    const toolCall = acpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Run checks",
      status: "pending",
    });
    const toolCallCompanion = assistantCompanion([{
      type: "tool_use",
      id: "tool-1",
      name: "Run checks",
      input: { apiKey: privatePairingSentinel },
    }]);
    const toolUpdate = acpUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    });
    const toolResultCompanion = sdkEvent({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: privatePairingSentinel,
        }],
      },
    });
    const toolLifecycle = [toolCall, toolCallCompanion, toolUpdate, toolResultCompanion];
    const newestText = textEvent(++sequence, "newest standalone row");
    const events = [
      oldMessageRaw,
      oldMessageCompanion,
      oldText,
      ...selectedMessageStream,
      ...selectedThoughtStream,
      ...toolLifecycle,
      newestText,
    ];

    const tail = tailRunEventsByVisibleItems(events, 4);

    expect(events.length).toBeGreaterThan(4);
    expect(tail).toEqual([
      ...selectedMessageStream,
      ...selectedThoughtStream,
      ...toolLifecycle,
      newestText,
    ]);
    expect(tail).not.toContain(oldMessageRaw);
    expect(tail).not.toContain(oldMessageCompanion);
    expect(tail).not.toContain(oldText);
    expect(tailRunEventsByVisibleItems(toolLifecycle, 1)).toEqual(toolLifecycle);

    for (const [raw, companion] of [
      [oldMessageRaw, oldMessageCompanion],
      [messageRawOne, messageCompanionOne],
      [messageRawTwo, messageCompanionTwo],
      [thoughtRawOne, thoughtCompanionOne],
      [thoughtRawTwo, thoughtCompanionTwo],
      [toolCall, toolCallCompanion],
      [toolUpdate, toolResultCompanion],
    ]) {
      expect(tail.includes(companion)).toBe(tail.includes(raw));
    }
  });

  it("keeps non-text ACP message companions paired at a tail boundary", () => {
    const secret = "PRIVATE_NON_TEXT_ACP_SENTINEL";
    const raw = {
      type: "sdk_event",
      event: {
        type: "acp_session_update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: secret, mimeType: "image/png" },
        },
      },
      _event_seq: 1,
    };
    const companion = {
      type: "sdk_event",
      event: {
        type: "assistant",
        message: {
          content: [{ type: "image", data: secret, mimeType: "image/png" }],
        },
      },
      _event_seq: 2,
    };

    expect(tailRunEventsByVisibleItems([
      { type: "text", text: "old", _event_seq: 0 },
      raw,
      companion,
    ], 1)).toEqual([raw, companion]);
  });

  it("bounds retained members of a legacy ACP message stream", () => {
    const events = [];
    let sequence = 0;
    const chunkCount = ACP_LEGACY_STREAM_EVENT_LIMIT + 25;
    for (let index = 0; index < chunkCount; index += 1) {
      const text = `chunk-${index}`;
      events.push({
        type: "sdk_event",
        event: {
          type: "acp_session_update",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "message-long",
            content: { type: "text", text },
          },
        },
        _event_seq: ++sequence,
      });
      events.push({
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text }] },
        },
        _event_seq: ++sequence,
      });
    }

    const tail = tailRunEventsByVisibleItems(events, 1);

    expect(tail).toHaveLength(ACP_LEGACY_STREAM_EVENT_LIMIT);
    expect(tail[0].event.type).toBe("acp_session_update");
    expect(tail.at(-1).event.type).toBe("assistant");
    for (let index = 0; index < tail.length; index += 2) {
      expect(tail[index].event.type).toBe("acp_session_update");
      expect(tail[index + 1].event.type).toBe("assistant");
    }
  });

  it("counts a native subagent group as one item and bounds its nested live rows", () => {
    const parent = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "spawn-1", name: "Agent", input: { prompt: "Review" } }] },
      _event_seq: 1,
    };
    const opened = {
      type: "subagent_activity",
      phase: "agent_started",
      id: "agent:spawn-1",
      subagent: { id: "spawn-1", nativeId: "child-1", name: "reviewer", callIndex: 0 },
      _event_seq: 2,
    };
    const nested = Array.from({ length: SUBAGENT_ACTIVITY_ROW_LIMIT + 25 }, (_, index) => ({
      type: "subagent_activity",
      phase: "message",
      id: `agent:spawn-1:message-${index}`,
      kind: "text",
      content: `child ${index}`,
      subagent: { id: "spawn-1", nativeId: "child-1", name: "reviewer", callIndex: 0 },
      _event_seq: index + 3,
    }));
    const closed = {
      type: "subagent_activity",
      phase: "agent_completed",
      id: "agent:spawn-1",
      subagent: { id: "spawn-1", nativeId: "child-1", name: "reviewer", callIndex: 0 },
      _event_seq: nested.length + 3,
    };
    const later = Array.from({ length: 9 }, (_, index) => textEvent(nested.length + 4 + index));

    const events = [parent, opened, ...nested, closed, ...later];
    const tail = tailRunEventsByVisibleItems(events, 10);

    expect(tail[0]).toBe(parent);
    expect(tail).toContain(closed);
    const retainedNested = tail.filter((event) => event.type === "subagent_activity"
      && !event.phase.startsWith("agent_"));
    expect(retainedNested).toHaveLength(SUBAGENT_ACTIVITY_ROW_LIMIT);
    expect(tail.find((event) => event.phase === "agent_started")?._worklab_subagent_omitted_rows).toBe(25);
    expect(tail.slice(-9)).toEqual(later);

    // The nested-row cap is independent of the outer visible-item limit.
    // A caller asking for more items than the raw event count must not bypass
    // the live-memory bound.
    const wideTail = tailRunEventsByVisibleItems(events, 500);
    expect(wideTail.filter((event) => event.type === "subagent_activity"
      && !event.phase.startsWith("agent_"))).toHaveLength(SUBAGENT_ACTIVITY_ROW_LIMIT);
    expect(wideTail.find((event) => event.phase === "agent_started")?._worklab_subagent_omitted_rows).toBe(25);
  });

  it("does not attach subagent rows to a colliding non-spawn tool id", () => {
    const events = [
      { type: "tool_use", tool_use_id: "read-1", name: "Read", input: {}, _event_seq: 1 },
      {
        type: "subagent_activity",
        phase: "agent_started",
        id: "agent:read-1",
        subagent: { id: "read-1", name: "reviewer", callIndex: 0 },
        _event_seq: 2,
      },
      ...Array.from({ length: 9 }, (_, index) => textEvent(index + 3)),
    ];

    const tail = tailRunEventsByVisibleItems(events, 10);

    expect(tail).not.toContain(events[0]);
    expect(tail).toContain(events[1]);
  });
});
