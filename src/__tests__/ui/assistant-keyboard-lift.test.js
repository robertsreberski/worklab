import { describe, expect, it } from "vitest";
import {
  computeAssistantKeyboardLift,
  computeAssistantKeyboardLiftState,
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

  it("uses measured lift when the visual viewport exposes the hidden keyboard area", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 520,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 768,
      composerBottom: 844,
      textareaBottom: 812,
      headerBottom: 76,
      composerFocused: true,
      mobileLayout: true,
    })).toMatchObject({
      lift: 332,
      mode: "measured",
      fallbackLift: 388,
    });
  });

  it("uses fallback lift when iOS reports a full-height visual viewport while focused", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 844,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 768,
      composerBottom: 844,
      textareaBottom: 812,
      headerBottom: 76,
      composerFocused: true,
      mobileLayout: true,
    })).toMatchObject({
      lift: 388,
      mode: "fallback",
      fallbackLift: 388,
    });
  });

  it("uses fallback lift when the visible viewport shrink is below the measured threshold", () => {
    expect(computeAssistantKeyboardLiftState({
      keyboardHeight: 120,
      visibleBottom: 700,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 768,
      composerBottom: 844,
      textareaBottom: 812,
      headerBottom: 76,
      composerFocused: true,
      mobileLayout: true,
    })).toMatchObject({
      lift: 388,
      mode: "fallback",
      fallbackLift: 388,
    });
  });

  it("caps fallback lift so the composer stays below the assistant header", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 700,
      dockBottom: 700,
      dockHeight: 700,
      composerTop: 360,
      composerBottom: 430,
      textareaBottom: 412,
      headerBottom: 100,
      composerFocused: true,
      mobileLayout: true,
    })).toMatchObject({
      lift: 248,
      mode: "fallback",
      fallbackLift: 248,
    });
  });

  it("does not fallback outside focused mobile assistant input state", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 844,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 768,
      composerBottom: 844,
      textareaBottom: 812,
      headerBottom: 76,
      composerFocused: false,
      mobileLayout: true,
    })).toMatchObject({ lift: 0, mode: "none" });
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 844,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 768,
      composerBottom: 844,
      textareaBottom: 812,
      headerBottom: 76,
      composerFocused: true,
      mobileLayout: false,
    })).toMatchObject({ lift: 0, mode: "none" });
  });
});
