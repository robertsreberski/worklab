import { describe, expect, it } from "vitest";
import { liveRunComposerState } from "../../ui/src/components/LiveRunPanel.jsx";

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
