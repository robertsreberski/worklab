import { describe, expect, it } from "vitest";
import {
  liveRunComposerState,
  liveRunElapsedMetricState,
  liveRunTodoPanelState,
} from "../../ui/src/components/LiveRunPanel.jsx";

describe("live run composer visibility", () => {
  it("shows for streaming Codex runs even before live input metadata is hydrated", () => {
    expect(liveRunComposerState({ id: "run-1", provider_kind: "codex" }, true)).toEqual({
      visible: true,
      canEdit: true,
      canSend: true,
    });
  });

  it("shows for streaming pi-agent OpenAI runs", () => {
    expect(liveRunComposerState({ id: "run-1", provider_kind: "openai" }, true)).toEqual({
      visible: true,
      canEdit: true,
      canSend: true,
    });
  });

  it("hides for unsupported streaming providers", () => {
    expect(liveRunComposerState({ id: "run-1", provider_kind: "unknown" }, true)).toEqual({
      visible: false,
      canEdit: false,
      canSend: false,
    });
  });

  it("hides when the run is not streaming", () => {
    expect(liveRunComposerState({ id: "run-1", provider_kind: "codex" }, false)).toEqual({
      visible: false,
      canEdit: false,
      canSend: false,
    });
  });

  it("stays visible but not sendable while the worker is not accepting live input", () => {
    expect(liveRunComposerState({
      id: "run-1",
      provider_kind: "codex",
      live_input: { supported: true, active: false, reason: "not_active" },
    }, true)).toEqual({
      visible: true,
      canEdit: true,
      canSend: false,
    });
  });
});

describe("live run todo panel state", () => {
  it("returns one display label per todo and orders completed work last", () => {
    expect(liveRunTodoPanelState({
      todo_state: {
        todos: [
          { content: "Inspect repo", status: "completed" },
          { content: "Write tests", status: "pending" },
          { content: "Wire MCP tool", status: "in_progress", active_form: "Implementing handlers" },
          { content: "Polish UI", status: "pending" },
        ],
        updated_at: 123,
        update_count: 2,
      },
    })).toEqual({
      visible: true,
      current: { content: "Wire MCP tool", status: "in_progress", active_form: "Implementing handlers", label: "Implementing handlers" },
      pending: [
        { content: "Write tests", status: "pending", label: "Write tests" },
        { content: "Polish UI", status: "pending", label: "Polish UI" },
      ],
      completed: [
        { content: "Inspect repo", status: "completed", label: "Inspect repo" },
      ],
      completedCount: 1,
      total: 4,
      updatedAt: 123,
    });
  });

  it("hides when the run has no todo items", () => {
    expect(liveRunTodoPanelState({ todo_state: { todos: [] } })).toEqual({
      visible: false,
      current: null,
      pending: [],
      completed: [],
      completedCount: 0,
      total: 0,
      updatedAt: null,
    });
  });
});

describe("live run elapsed metric state", () => {
  it("shows elapsed time for a running run with a start time", () => {
    expect(liveRunElapsedMetricState({
      id: "run-1",
      process_status: "running",
      started_at: 1_000,
    }, false, 6_500)).toEqual({
      visible: true,
      label: "Elapsed",
      value: "5.5s",
      elapsedMs: 5_500,
    });
  });

  it("shows elapsed time for a streaming run before status hydration completes", () => {
    expect(liveRunElapsedMetricState({
      id: "run-1",
      started_at: 1_000,
    }, true, 1_750)).toEqual({
      visible: true,
      label: "Elapsed",
      value: "750ms",
      elapsedMs: 750,
    });
  });

  it("hides when the running run has no start time", () => {
    expect(liveRunElapsedMetricState({
      id: "run-1",
      process_status: "running",
    }, true, 6_500)).toEqual({
      visible: false,
      label: "Elapsed",
      value: null,
      elapsedMs: null,
    });
  });

  it("hides after the run has ended so completed duration remains authoritative", () => {
    expect(liveRunElapsedMetricState({
      id: "run-1",
      process_status: "completed",
      started_at: 1_000,
      ended_at: 6_500,
    }, false, 7_000)).toEqual({
      visible: false,
      label: "Elapsed",
      value: null,
      elapsedMs: null,
    });
  });
});
