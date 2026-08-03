import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeAssistantRunStreamsForTests,
  refreshAssistantRunState,
  subscribeAssistantRunState,
} from "../../ui/src/lib/useAssistantRunStream.js";

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.close = vi.fn();
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
}

describe("assistant run stream state", () => {
  beforeEach(() => {
    globalThis.EventSource = FakeEventSource;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        run: {
          id: "assistant-run-1",
          status: "running",
          events: [{ type: "started", text: "Assistant run started", _event_seq: 0 }],
          event_count: 1,
          events_truncated: false,
        },
      }),
    }));
  });

  afterEach(() => {
    closeAssistantRunStreamsForTests();
    FakeEventSource.instances = [];
    delete globalThis.EventSource;
    delete globalThis.fetch;
  });

  it("uses the shared global stream for assistant run progress", async () => {
    const snapshots = [];
    const unsubscribe = subscribeAssistantRunState("assistant-run-1", (snapshot) => snapshots.push(snapshot), {
      subscribe: true,
      pollMs: 0,
    });

    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toMatchObject({ loading: false });
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/events/stream");

    FakeEventSource.instances[0].onmessage({
      data: JSON.stringify({
        type: "assistant_run_event",
        thread_id: "personal",
        run_id: "assistant-run-1",
        event_seq: 1,
        event: { type: "assistant", text: "Working", _event_seq: 1 },
      }),
    });

    await vi.waitFor(() => {
      expect(snapshots.at(-1).events.map((event) => event._event_seq)).toEqual([0, 1]);
    });

    unsubscribe();
  });

  it("marks the run done from the global terminal payload", async () => {
    const snapshots = [];
    const unsubscribe = subscribeAssistantRunState("assistant-run-1", (snapshot) => snapshots.push(snapshot), {
      subscribe: true,
      pollMs: 0,
    });

    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toMatchObject({ loading: false });
    });

    FakeEventSource.instances[0].onmessage({
      data: JSON.stringify({
        type: "assistant_run_ended",
        thread_id: "personal",
        run_id: "assistant-run-1",
        status: "succeeded",
        run: { id: "assistant-run-1", status: "succeeded" },
        message: { id: "assistant-message-1", body: "Done.", run: { id: "assistant-run-1", status: "succeeded" } },
      }),
    });

    await vi.waitFor(() => {
      const latest = snapshots.at(-1);
      expect(latest.done).toBe(true);
      expect(latest.donePayload.message.body).toBe("Done.");
      expect(latest.run.status).toBe("succeeded");
    });

    unsubscribe();
  });

  it("recovers a missed terminal event through hydration refresh", async () => {
    const snapshots = [];
    globalThis.fetch = vi.fn(async () => {
      const callNumber = globalThis.fetch.mock.calls.length;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          run: callNumber === 1
            ? { id: "assistant-run-1", status: "running", events: [], event_count: 0 }
            : {
                id: "assistant-run-1",
                status: "succeeded",
                events: [{ type: "final", text: "Recovered.", _event_seq: 1 }],
                event_count: 2,
              },
        }),
      };
    });

    const unsubscribe = subscribeAssistantRunState("assistant-run-1", (snapshot) => snapshots.push(snapshot), {
      subscribe: true,
      pollMs: 0,
    });

    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toMatchObject({ loading: false, done: false });
    });

    await refreshAssistantRunState("assistant-run-1", { subscribe: true });

    await vi.waitFor(() => {
      const latest = snapshots.at(-1);
      expect(latest.done).toBe(true);
      expect(latest.run.status).toBe("succeeded");
      expect(latest.events.at(-1)).toMatchObject({ type: "final", text: "Recovered." });
    });

    unsubscribe();
  });

  it("keeps a completed live subagent group bounded with its lifecycle bookends", async () => {
    const snapshots = [];
    const unsubscribe = subscribeAssistantRunState("assistant-run-1", (snapshot) => snapshots.push(snapshot), {
      subscribe: true,
      pollMs: 0,
    });
    await vi.waitFor(() => expect(snapshots.at(-1)).toMatchObject({ loading: false }));
    const stream = FakeEventSource.instances[0];
    let seq = 1;
    const send = (event) => stream.onmessage({
      data: JSON.stringify({
        type: "assistant_run_event",
        thread_id: "personal",
        run_id: "assistant-run-1",
        event_seq: seq,
        event: { ...event, _event_seq: seq++ },
      }),
    });
    send({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "spawn-live", name: "Agent", input: {} }] },
    });
    send({
      type: "subagent_activity",
      phase: "agent_started",
      id: "agent:spawn-live",
      subagent: { id: "spawn-live", name: "reviewer", callIndex: 0 },
    });
    for (let index = 0; index < 225; index += 1) {
      send({
        type: "subagent_activity",
        phase: "message",
        id: `agent:spawn-live:message-${index}`,
        kind: "text",
        content: `child ${index}`,
        subagent: { id: "spawn-live", name: "reviewer", callIndex: 0 },
      });
    }
    send({
      type: "subagent_activity",
      phase: "agent_completed",
      id: "agent:spawn-live",
      subagent: { id: "spawn-live", name: "reviewer", callIndex: 0 },
    });
    stream.onmessage({
      data: JSON.stringify({
        type: "assistant_run_ended",
        thread_id: "personal",
        run_id: "assistant-run-1",
        status: "succeeded",
        run: { id: "assistant-run-1", status: "succeeded" },
      }),
    });

    await vi.waitFor(() => expect(snapshots.at(-1).done).toBe(true));
    const latest = snapshots.at(-1);
    const activity = latest.events.filter((event) => event.type === "subagent_activity");
    expect(activity.filter((event) => event.phase === "message")).toHaveLength(200);
    expect(activity.find((event) => event.phase === "agent_started")?._worklab_subagent_omitted_rows).toBe(25);
    expect(activity.at(-1)?.phase).toBe("agent_completed");
    expect(latest.eventsTruncated).toBe(true);

    unsubscribe();
  });
});
