import { describe, it, expect } from "vitest";
import {
  decidePlacement,
  computeCoords,
  DEFAULT_MIN_SPACE,
} from "../../ui/src/hooks/useDropdownPlacement.js";

function rect(top, height = 32, { left = 0, width = 200 } = {}) {
  return {
    top,
    bottom: top + height,
    height,
    left,
    right: left + width,
    width,
    x: left,
    y: top,
  };
}

describe("decidePlacement", () => {
  it("picks below when there is plenty of room and preferred is below", () => {
    const result = decidePlacement({
      anchorRect: rect(80),
      popoverHeight: 240,
      viewportHeight: 800,
    });
    expect(result.placement).toBe("below");
    expect(result.maxHeight).toBeNull();
  });

  it("flips to above when below is clipped", () => {
    const result = decidePlacement({
      anchorRect: rect(720),
      popoverHeight: 240,
      viewportHeight: 800,
    });
    expect(result.placement).toBe("above");
    expect(result.maxHeight).toBeNull();
  });

  it("picks the larger side and caps maxHeight when neither side fits", () => {
    const result = decidePlacement({
      anchorRect: rect(180, 40),
      popoverHeight: 400,
      viewportHeight: 400,
    });
    expect(["above", "below"]).toContain(result.placement);
    expect(typeof result.maxHeight).toBe("number");
    expect(result.maxHeight).toBeGreaterThan(0);
    expect(result.maxHeight).toBeLessThan(400);
  });

  it("biases to the side with more room when both are tight", () => {
    const tightAtTop = decidePlacement({
      anchorRect: rect(40, 32),
      popoverHeight: 400,
      viewportHeight: 300,
    });
    expect(tightAtTop.placement).toBe("below");

    const tightAtBottom = decidePlacement({
      anchorRect: rect(220, 32),
      popoverHeight: 400,
      viewportHeight: 300,
    });
    expect(tightAtBottom.placement).toBe("above");
  });

  it("falls back to minSpace heuristic when popover height is unknown", () => {
    const result = decidePlacement({
      anchorRect: rect(40),
      popoverHeight: 0,
      viewportHeight: 800,
    });
    expect(result.placement).toBe("below");
    expect(result.maxHeight).toBeNull();

    const tight = decidePlacement({
      anchorRect: rect(800 - 50, 32),
      popoverHeight: 0,
      viewportHeight: 800,
    });
    // No room below for minSpace; should flip up.
    expect(tight.placement).toBe("above");
  });

  it("respects an above-preferred caller (e.g. tooltip placement='top')", () => {
    const result = decidePlacement({
      anchorRect: rect(400, 24),
      popoverHeight: 80,
      viewportHeight: 800,
      preferred: "above",
    });
    expect(result.placement).toBe("above");
  });

  it("flips an above-preferred caller to below when above is clipped", () => {
    const result = decidePlacement({
      anchorRect: rect(8, 24),
      popoverHeight: 80,
      viewportHeight: 800,
      preferred: "above",
    });
    expect(result.placement).toBe("below");
  });

  it("treats DEFAULT_MIN_SPACE as the heuristic threshold", () => {
    expect(DEFAULT_MIN_SPACE).toBeGreaterThan(0);
    const justEnoughBelow = decidePlacement({
      anchorRect: rect(40, 32),
      popoverHeight: 0,
      viewportHeight: 40 + 32 + DEFAULT_MIN_SPACE + 16,
    });
    expect(justEnoughBelow.placement).toBe("below");
  });
});

describe("computeCoords", () => {
  it("anchors below the trigger with gap when placement is below", () => {
    const coords = computeCoords({
      anchorRect: rect(100, 32, { left: 40 }),
      placement: "below",
      popoverWidth: 200,
      popoverHeight: 240,
      viewportWidth: 1024,
      viewportHeight: 800,
      gap: 4,
    });
    expect(coords.top).toBe(100 + 32 + 4);
    expect(coords.left).toBe(40);
  });

  it("stacks the popover above the trigger when placement is above", () => {
    const coords = computeCoords({
      anchorRect: rect(600, 32, { left: 80 }),
      placement: "above",
      popoverWidth: 200,
      popoverHeight: 240,
      viewportWidth: 1024,
      viewportHeight: 800,
      gap: 4,
    });
    // top of trigger - gap - popover height
    expect(coords.top).toBe(600 - 4 - 240);
    expect(coords.left).toBe(80);
  });

  it("clamps left so the popover stays inside the right viewport edge", () => {
    const viewportWidth = 400;
    const popoverWidth = 200;
    const margin = 8;
    const coords = computeCoords({
      anchorRect: rect(100, 32, { left: 350, width: 40 }),
      placement: "below",
      popoverWidth,
      popoverHeight: 240,
      viewportWidth,
      viewportHeight: 800,
      margin,
    });
    expect(coords.left).toBe(viewportWidth - popoverWidth - margin);
  });

  it("clamps left to the margin when the trigger is past the left edge", () => {
    const margin = 8;
    const coords = computeCoords({
      anchorRect: rect(100, 32, { left: -50, width: 40 }),
      placement: "below",
      popoverWidth: 200,
      popoverHeight: 240,
      viewportWidth: 1024,
      viewportHeight: 800,
      margin,
    });
    expect(coords.left).toBe(margin);
  });

  it("does not clamp when popoverWidth is unknown", () => {
    // First-pass measurement: popover not yet rendered, width is 0. Use the
    // raw anchor.left rather than a misleading clamp to (vw - 0 - margin).
    const coords = computeCoords({
      anchorRect: rect(100, 32, { left: 350, width: 40 }),
      placement: "below",
      popoverWidth: 0,
      popoverHeight: 0,
      viewportWidth: 400,
      viewportHeight: 800,
    });
    expect(coords.left).toBe(350);
  });

  it("never lets the above-placed popover go negative on top", () => {
    const margin = 8;
    const coords = computeCoords({
      anchorRect: rect(40, 32, { left: 0 }),
      placement: "above",
      popoverWidth: 200,
      popoverHeight: 400,
      viewportWidth: 1024,
      viewportHeight: 800,
      margin,
      gap: 4,
    });
    expect(coords.top).toBe(margin);
  });
});
