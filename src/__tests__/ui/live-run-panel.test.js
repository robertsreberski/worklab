import { describe, expect, it } from "vitest";
import { liveRunComposerState } from "../../ui/src/components/LiveRunPanel.jsx";

describe("live run composer visibility", () => {
  it("shows for streaming Codex runs even before live input metadata is hydrated", () => {
    expect(liveRunComposerState({ id: "run-1", provider_kind: "codex" }, true)).toEqual({
      visible: true,
      canSend: true,
    });
  });

  it("hides for unsupported streaming providers", () => {
    expect(liveRunComposerState({ id: "run-1", provider_kind: "openai" }, true)).toEqual({
      visible: false,
      canSend: false,
    });
  });

  it("hides when the run is not streaming", () => {
    expect(liveRunComposerState({ id: "run-1", provider_kind: "codex" }, false)).toEqual({
      visible: false,
      canSend: false,
    });
  });
});
