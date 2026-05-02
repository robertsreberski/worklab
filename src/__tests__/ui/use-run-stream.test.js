import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeRunStreamsForTests,
  loadFullRunHistory,
  refreshRunState,
  subscribeRunState,
  subscribeRunStream,
  todoStateFromToolEvents,
} from "../../ui/src/lib/useRunStream.js";

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

describe("shared run stream subscriptions", () => {
  beforeEach(() => {
    globalThis.EventSource = FakeEventSource;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        run: { id: "run-1", status: "running", process_status: "running" },
        log: {
          events: [{ type: "text", text: "hydrated", _event_seq: 1 }],
          event_count: 1,
        },
      }),
    }));
  });

  afterEach(() => {
    closeRunStreamsForTests();
    FakeEventSource.instances = [];
    delete globalThis.EventSource;
    delete globalThis.fetch;
  });

  it("fans out one run EventSource to multiple subscribers", () => {
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = subscribeRunStream("run-1", first);
    const unsubscribeSecond = subscribeRunStream("run-1", second);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/runs/run-1/stream");

    FakeEventSource.instances[0].onmessage({ data: JSON.stringify({ type: "text", text: "working", _event_seq: 1 }) });

    expect(first).toHaveBeenCalledWith({ type: "text", text: "working", _event_seq: 1 });
    expect(second).toHaveBeenCalledWith({ type: "text", text: "working", _event_seq: 1 });

    unsubscribeFirst();
    expect(FakeEventSource.instances[0].close).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("shares one compact run hydration request across subscribers", async () => {
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = subscribeRunState("run-1", first, { subscribe: true });
    const unsubscribeSecond = subscribeRunState("run-1", second, { subscribe: true });

    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledWith(expect.objectContaining({
        loading: false,
        events: [{ type: "text", text: "hydrated", _event_seq: 1 }],
        run: { id: "run-1", status: "running", process_status: "running" },
      }));
      expect(second).toHaveBeenCalledWith(expect.objectContaining({ loading: false }));
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/runs/run-1?events=tail&limit=10",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(FakeEventSource.instances).toHaveLength(1);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("extracts run todo state from successful todo_write tool results", () => {
    expect(todoStateFromToolEvents({ todos: [], updated_at: null, update_count: 0 }, [
      {
        type: "tool_use",
        tool_use_id: "todo-1",
        name: "mcp__worklab__todo_write",
        input: { todos: [{ content: "Wire MCP tool", status: "in_progress" }] },
      },
      {
        type: "tool_result",
        tool_use_id: "todo-1",
        content: JSON.stringify({
          ok: true,
          todo_state: {
            todos: [{ content: "Wire MCP tool", status: "in_progress" }],
            updated_at: 123,
            update_count: 1,
            total: 1,
            completed: 0,
          },
        }),
        is_error: false,
      },
    ])).toMatchObject({
      total: 1,
      completed: 0,
      update_count: 1,
      todos: [{ content: "Wire MCP tool", status: "in_progress" }],
    });
  });

  it("keeps live updates capped to the latest 10 visible items before full history loads", async () => {
    const snapshots = [];
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        run: { id: "run-tail", status: "running", process_status: "running" },
        log: { events: [], event_count: 0, events_truncated: false },
      }),
    }));

    const unsubscribe = subscribeRunState("run-tail", (snapshot) => snapshots.push(snapshot), { subscribe: true });

    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toMatchObject({ loading: false });
    });

    // Stream events can arrive before compact hydration resolves; hydration must not reset the observed tail.
    for (let index = 1; index <= 25; index += 1) {
      FakeEventSource.instances[0].onmessage({
        data: JSON.stringify({ type: "text", text: `event ${index}`, _event_seq: index }),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    const latest = snapshots.at(-1);
    expect(latest.events.map((event) => event._event_seq)).toEqual([
      16, 17, 18, 19, 20,
      21, 22, 23, 24, 25,
    ]);
    expect(latest.eventCount).toBe(25);
    expect(latest.eventsTruncated).toBe(true);
    expect(latest.fullHistoryLoaded).toBe(false);

    unsubscribe();
  });

  it("keeps paired tool calls atomic when the live tail crosses a raw event boundary", async () => {
    const snapshots = [];
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        run: { id: "run-atomic-tail", status: "running", process_status: "running" },
        log: { events: [], event_count: 0, events_truncated: false },
      }),
    }));

    const unsubscribe = subscribeRunState("run-atomic-tail", (snapshot) => snapshots.push(snapshot), {
      subscribe: true,
      maxEvents: 10,
    });

    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toMatchObject({ loading: false });
    });

    FakeEventSource.instances[0].onmessage({
      data: JSON.stringify({ type: "text", text: "old event", _event_seq: 1 }),
    });
    FakeEventSource.instances[0].onmessage({
      data: JSON.stringify({
        type: "tool_use",
        tool_use_id: "tool-1",
        name: "shell",
        input: { cmd: "npm test" },
        _event_seq: 2,
      }),
    });
    for (let index = 3; index <= 21; index += 1) {
      FakeEventSource.instances[0].onmessage({
        data: JSON.stringify({ type: "text", text: `event ${index}`, _event_seq: index }),
      });
    }
    FakeEventSource.instances[0].onmessage({
      data: JSON.stringify({
        type: "tool_result",
        tool_use_id: "tool-1",
        output: "ok",
        is_error: false,
        _event_seq: 22,
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const latest = snapshots.at(-1);
    expect(latest.events).toHaveLength(11);
    expect(latest.events.map((event) => event._event_seq)).toEqual([
      2, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    ]);
    expect(latest.events[0]).toMatchObject({ type: "tool_use", tool_use_id: "tool-1" });
    expect(latest.events.at(-1)).toMatchObject({ type: "tool_result", tool_use_id: "tool-1" });
    expect(latest.eventCount).toBe(22);
    expect(latest.eventsTruncated).toBe(true);
    expect(latest.fullHistoryLoaded).toBe(false);

    unsubscribe();
  });

  it("keeps live file artifacts after their source events leave the compact tail", async () => {
    const snapshots = [];
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        run: { id: "run-artifacts", status: "running", process_status: "running" },
        log: { events: [], event_count: 0, events_truncated: false },
      }),
    }));

    const unsubscribe = subscribeRunState("run-artifacts", (snapshot) => snapshots.push(snapshot), {
      subscribe: true,
      maxEvents: 10,
    });

    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toMatchObject({ loading: false });
    });

    FakeEventSource.instances[0].onmessage({
      data: JSON.stringify({
        type: "tool_result",
        content: {
          status: "completed",
          changes: [{
            path: "src/first.js",
            kind: "update",
            line_stats: { before_lines: 1, after_lines: 2, added_lines: 1, removed_lines: 0 },
          }],
        },
        _event_seq: 1,
      }),
    });
    for (let index = 2; index <= 25; index += 1) {
      FakeEventSource.instances[0].onmessage({
        data: JSON.stringify({ type: "text", text: `event ${index}`, _event_seq: index }),
      });
    }
    FakeEventSource.instances[0].onmessage({
      data: JSON.stringify({
        type: "tool_result",
        content: {
          status: "completed",
          changes: [{
            path: "src/latest.js",
            kind: "add",
            line_stats: { before_lines: 0, after_lines: 3, added_lines: 3, removed_lines: 0 },
          }],
        },
        _event_seq: 26,
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const latest = snapshots.at(-1);
    expect(latest.events.map((event) => event._event_seq)).toEqual([
      17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    ]);
    expect(latest.liveArtifacts.map((artifact) => artifact.path)).toEqual(["src/first.js", "src/latest.js"]);

    unsubscribe();
  });

  it("can upgrade a compact live hydration to full history without trimming future events", async () => {
    const snapshots = [];
    globalThis.fetch = vi.fn(async (url) => {
      const requestUrl = String(url);
      const events = Array.from({ length: 10 }, (_, index) => ({
        type: "text",
        text: `event ${index + 1}`,
        _event_seq: index + 1,
      }));
      return {
        ok: true,
        json: async () => ({
          run: { id: "run-full", status: "running", process_status: "running" },
          log: requestUrl.includes("events=tail")
            ? { events: events.slice(-3), event_count: 10, events_truncated: true }
            : { events, event_count: 10, events_truncated: false },
        }),
      };
    });

    const unsubscribe = subscribeRunState("run-full", (snapshot) => snapshots.push(snapshot), {
      subscribe: true,
      initialEventLimit: 3,
      maxEvents: 3,
    });

    await vi.waitFor(() => {
      const latest = snapshots.at(-1);
      expect(latest.events.map((event) => event._event_seq)).toEqual([8, 9, 10]);
      expect(latest.eventCount).toBe(10);
      expect(latest.eventsTruncated).toBe(true);
      expect(latest.fullHistoryLoaded).toBe(false);
    });

    await loadFullRunHistory("run-full");

    await vi.waitFor(() => {
      const latest = snapshots.at(-1);
      expect(latest.events.map((event) => event._event_seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(latest.eventCount).toBe(10);
      expect(latest.eventsTruncated).toBe(false);
      expect(latest.fullHistoryLoaded).toBe(true);
    });

    FakeEventSource.instances[0].onmessage({ data: JSON.stringify({ type: "text", text: "event 11", _event_seq: 11 }) });

    await vi.waitFor(() => {
      const latest = snapshots.at(-1);
      expect(latest.events.map((event) => event._event_seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(latest.eventCount).toBe(11);
      expect(latest.eventsTruncated).toBe(false);
    });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/runs/run-full?events=tail&limit=3",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/runs/run-full",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    unsubscribe();
  });

  it("force refreshes the current tail after app resume", async () => {
    const snapshots = [];
    globalThis.fetch = vi.fn(async () => {
      const callNumber = globalThis.fetch.mock.calls.length;
      return {
        ok: true,
        json: async () => callNumber === 1
          ? {
              run: { id: "run-resume", status: "running", process_status: "running" },
              log: {
                events: [{ type: "text", text: "before background", _event_seq: 1 }],
                event_count: 1,
                events_truncated: false,
              },
            }
          : {
              run: { id: "run-resume", status: "completed", process_status: "completed" },
              log: {
                events: [
                  { type: "text", text: "missed while hidden", _event_seq: 2 },
                  { type: "text", text: "finished while hidden", _event_seq: 3 },
                ],
                event_count: 3,
                events_truncated: false,
              },
            },
      };
    });

    const unsubscribe = subscribeRunState("run-resume", (snapshot) => snapshots.push(snapshot), {
      subscribe: true,
    });

    await vi.waitFor(() => {
      const latest = snapshots.at(-1);
      expect(latest.events.map((event) => event._event_seq)).toEqual([1]);
      expect(latest.done).toBe(false);
    });

    await refreshRunState("run-resume");

    await vi.waitFor(() => {
      const latest = snapshots.at(-1);
      expect(latest.events.map((event) => event._event_seq)).toEqual([1, 2, 3]);
      expect(latest.run.process_status).toBe("completed");
      expect(latest.done).toBe(true);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    unsubscribe();
  });
});
