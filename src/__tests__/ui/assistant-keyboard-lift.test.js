import { describe, expect, it } from "vitest";
import {
  computeAssistantKeyboardLift,
  readCssPxValue,
  visualViewportBottom,
} from "../../ui/src/lib/assistantKeyboardLift.js";

describe("assistant keyboard lift", () => {
  it("uses the global keyboard height when viewport metrics are trustworthy", () => {
    expect(computeAssistantKeyboardLift({
      keyboardHeight: 324,
      visibleBottom: 520,
      composerBottom: 512,
      textareaBottom: 500,
      currentLift: 324,
    })).toBe(324);
  });

  it("lifts beyond underreported global keyboard height when the composer overlaps the visible viewport", () => {
    expect(computeAssistantKeyboardLift({
      keyboardHeight: 120,
      visibleBottom: 520,
      composerBottom: 844,
      textareaBottom: 812,
    })).toBe(332);
  });

  it("accounts for the current transform so repeated measurement does not collapse the lift", () => {
    expect(computeAssistantKeyboardLift({
      keyboardHeight: 120,
      visibleBottom: 520,
      composerBottom: 512,
      textareaBottom: 480,
      currentLift: 332,
    })).toBe(332);
  });

  it("does not lift at rest when the composer is already within the visible viewport", () => {
    expect(computeAssistantKeyboardLift({
      keyboardHeight: 0,
      visibleBottom: 844,
      composerBottom: 844,
      textareaBottom: 812,
    })).toBe(0);
  });

  it("reads viewport bottom and CSS pixel values defensively", () => {
    expect(visualViewportBottom({
      innerHeight: 844,
      visualViewport: { height: 520.4, offsetTop: 12.2 },
    })).toBe(532);
    expect(readCssPxValue(" 324px ")).toBe(324);
    expect(readCssPxValue("none")).toBe(0);
  });
});
