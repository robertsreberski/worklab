import { describe, expect, it } from "vitest";
import {
  ASSISTANT_WIDTH_DEFAULT,
  ASSISTANT_WIDTH_MAX,
  ASSISTANT_WIDTH_MIN,
  ASSISTANT_WIDTH_STORAGE_KEY,
  assistantInitialWidth,
  assistantMaxWidthForViewport,
  assistantWidthFromStorage,
  clampAssistantWidth,
} from "../../ui/src/lib/assistantLayout.js";

function storageWith(value) {
  return {
    getItem(key) {
      return key === ASSISTANT_WIDTH_STORAGE_KEY ? value : null;
    },
  };
}

describe("assistant layout width helpers", () => {
  it("clamps requested widths to the assistant range", () => {
    expect(clampAssistantWidth(100, 1440)).toBe(ASSISTANT_WIDTH_MIN);
    expect(clampAssistantWidth(900, 1440)).toBe(ASSISTANT_WIDTH_MAX);
    expect(clampAssistantWidth("512px", 1440)).toBe(512);
  });

  it("keeps enough viewport room for the main content on narrower desktop widths", () => {
    expect(assistantMaxWidthForViewport(1000)).toBe(416);
    expect(clampAssistantWidth(680, 1000)).toBe(416);
  });

  it("does not shrink stored desktop widths just because the app opens on mobile", () => {
    expect(assistantMaxWidthForViewport(820)).toBe(ASSISTANT_WIDTH_MAX);
    expect(clampAssistantWidth(640, 820)).toBe(640);
  });

  it("reads a valid stored width and falls back for invalid values", () => {
    expect(assistantWidthFromStorage(storageWith("540"), 1440)).toBe(540);
    expect(assistantWidthFromStorage(storageWith("wide"), 1440)).toBe(ASSISTANT_WIDTH_DEFAULT);
  });

  it("handles unavailable localStorage safely", () => {
    const env = {
      innerWidth: 1440,
      get localStorage() {
        throw new Error("blocked");
      },
    };
    expect(assistantInitialWidth(env)).toBe(ASSISTANT_WIDTH_DEFAULT);
  });
});
