import { describe, expect, it } from "vitest";
import {
  computeAssistantKeyboardLift,
  computeAssistantKeyboardLiftState,
  readCssPxValue,
  visualViewportBottom,
} from "../../ui/src/lib/assistantKeyboardLift.js";

describe("assistant keyboard lift", () => {
  it("does not lift from keyboard height alone when the composer is already visible", () => {
    expect(computeAssistantKeyboardLift({
      keyboardHeight: 324,
      visibleBottom: 520,
      composerBottom: 512,
      textareaBottom: 500,
    })).toBe(0);
  });

  it("lifts only the observed overlap when the composer crosses the visible viewport", () => {
    expect(computeAssistantKeyboardLift({
      keyboardHeight: 120,
      visibleBottom: 520,
      composerBottom: 844,
      textareaBottom: 812,
    })).toBe(332);
  });

  it("accounts for the current dock inset so repeated measurement does not collapse the lift", () => {
    expect(computeAssistantKeyboardLift({
      keyboardHeight: 120,
      visibleBottom: 520,
      composerBottom: 512,
      textareaBottom: 480,
      currentLift: 332,
    })).toBe(332);
  });

  it("clears stale lift when native iOS pan already made the composer visible", () => {
    expect(computeAssistantKeyboardLift({
      keyboardHeight: 324,
      visibleBottom: 520,
      composerBottom: 180,
      textareaBottom: 168,
      currentLift: 332,
    })).toBe(0);
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

  it("uses observed lift when the visual viewport exposes hidden composer controls", () => {
    const state = computeAssistantKeyboardLiftState({
      visibleBottom: 520,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 768,
      composerBottom: 844,
      textareaBottom: 812,
      headerBottom: 76,
      composerFocused: true,
      mobileLayout: true,
    });

    expect(state).toMatchObject({
      lift: 332,
      mode: "measured",
      measuredLift: 332,
    });
    expect(state).not.toHaveProperty("fallbackLift");
    expect(state).not.toHaveProperty("estimatedKeyboardHeight");
    expect(state).not.toHaveProperty("fallbackTargetBottom");
  });

  it("uses bounded focus rescue when iOS reports a full-height viewport at the bottom", () => {
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
      textareaHeight: 44,
      safeAreaBottom: 34,
    })).toMatchObject({
      lift: 90,
      mode: "focus-rescue",
      measuredLift: 0,
      rescueLift: 90,
    });
  });

  it("caps focus rescue to a small control-row lift", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 844,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 720,
      composerBottom: 844,
      textareaBottom: 812,
      headerBottom: 76,
      composerFocused: true,
      mobileLayout: true,
      textareaHeight: 100,
      safeAreaBottom: 34,
    })).toMatchObject({
      lift: 96,
      mode: "focus-rescue",
      measuredLift: 0,
      rescueLift: 96,
    });
  });

  it("does not use focus rescue when native iOS pan already moved the composer away from the bottom", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 844,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 436,
      composerBottom: 512,
      textareaBottom: 500,
      headerBottom: 76,
      composerFocused: true,
      mobileLayout: true,
      textareaHeight: 44,
      safeAreaBottom: 34,
    })).toMatchObject({
      lift: 0,
      mode: "none",
      measuredLift: 0,
      rescueLift: 0,
    });
  });

  it("does not add lift when native iOS pan already clears the visible viewport", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 520,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 436,
      composerBottom: 512,
      textareaBottom: 500,
      headerBottom: 76,
      composerFocused: true,
      mobileLayout: true,
    })).toMatchObject({
      lift: 0,
      mode: "none",
      measuredLift: 0,
    });
  });

  it("adds only the remaining observed delta after partial native iOS pan", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 520,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 544,
      composerBottom: 620,
      textareaBottom: 600,
      headerBottom: 76,
      composerFocused: true,
      mobileLayout: true,
    })).toMatchObject({
      lift: 108,
      mode: "measured",
      measuredLift: 108,
    });
  });

  it("uses observed overlap even when global keyboard height is below threshold", () => {
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
      lift: 152,
      mode: "measured",
      measuredLift: 152,
    });
  });

  it("keeps observed lift bounded by actual visible overlap", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 700,
      dockBottom: 700,
      dockHeight: 700,
      composerTop: 360,
      composerBottom: 704,
      textareaBottom: 682,
      headerBottom: 100,
      composerFocused: true,
      mobileLayout: true,
    })).toMatchObject({
      lift: 12,
      mode: "measured",
      measuredLift: 12,
    });
  });

  it("does not lift outside focused assistant input state", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 520,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 768,
      composerBottom: 844,
      textareaBottom: 812,
      headerBottom: 76,
      composerFocused: false,
      mobileLayout: true,
    })).toMatchObject({ lift: 0, mode: "none" });
  });

  it("does not require mobile layout for an observed focused-input overlap", () => {
    expect(computeAssistantKeyboardLiftState({
      visibleBottom: 520,
      dockBottom: 844,
      dockHeight: 844,
      composerTop: 768,
      composerBottom: 844,
      textareaBottom: 812,
      headerBottom: 76,
      composerFocused: true,
      mobileLayout: false,
    })).toMatchObject({ lift: 332, mode: "measured" });
  });
});
