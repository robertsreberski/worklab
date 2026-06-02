// Viewport-aware placement for dropdowns/pickers/tooltips. Picks above
// vs below based on available space; caps max-height to the chosen side
// when neither direction fully fits the popover. Also returns viewport
// coordinates so consumers can render the popover in a portal with
// `position: fixed` — escaping any clipping ancestor or stacking-context
// trap (e.g. the mobile bottom sheet's `overflow: hidden` + `transform`).
//
// `decidePlacement` and `computeCoords` are pure (unit-tested); the hook
// wires lifecycle around them.

import { useLayoutEffect, useRef, useState } from "preact/hooks";

const DEFAULT_GAP = 4;
export const DEFAULT_MIN_SPACE = 120;
const DEFAULT_MARGIN = 8;

export function decidePlacement({
  anchorRect,
  popoverHeight = 0,
  viewportHeight,
  preferred = "below",
  gap = DEFAULT_GAP,
  minSpace = DEFAULT_MIN_SPACE,
  margin = DEFAULT_MARGIN,
}) {
  const spaceBelow = Math.max(0, viewportHeight - anchorRect.bottom - gap - margin);
  const spaceAbove = Math.max(0, anchorRect.top - gap - margin);
  // First-pass measurements often have popoverHeight 0 (popover not yet in
  // the DOM). Fall back to minSpace so the initial choice isn't always "below".
  const desired = popoverHeight > 0 ? popoverHeight : minSpace;
  const preferredSpace = preferred === "below" ? spaceBelow : spaceAbove;
  const otherSpace = preferred === "below" ? spaceAbove : spaceBelow;

  let placement;
  if (preferredSpace >= desired) placement = preferred;
  else if (otherSpace >= desired) placement = preferred === "below" ? "above" : "below";
  else placement = spaceBelow >= spaceAbove ? "below" : "above";

  const chosenSpace = placement === "below" ? spaceBelow : spaceAbove;
  const maxHeight = popoverHeight > 0 && chosenSpace < popoverHeight ? chosenSpace : null;

  return { placement, maxHeight };
}

export function computeCoords({
  anchorRect,
  placement,
  popoverWidth = 0,
  popoverHeight = 0,
  viewportWidth,
  viewportHeight,
  gap = DEFAULT_GAP,
  margin = DEFAULT_MARGIN,
}) {
  const top = placement === "below"
    ? anchorRect.bottom + gap
    : Math.max(margin, anchorRect.top - gap - popoverHeight);

  // Default to anchor-aligned. Clamp to viewport so the popover never spills
  // off the right edge when the trigger is near it.
  let left = anchorRect.left;
  if (popoverWidth > 0 && Number.isFinite(viewportWidth)) {
    const maxLeft = Math.max(margin, viewportWidth - popoverWidth - margin);
    if (left > maxLeft) left = maxLeft;
    if (left < margin) left = margin;
  }

  return { top, left };
}

export function useDropdownPlacement(anchorRef, popoverRef, open, options = {}) {
  const {
    preferred = "below",
    gap = DEFAULT_GAP,
    minSpace = DEFAULT_MIN_SPACE,
    margin = DEFAULT_MARGIN,
  } = options;

  const [state, setState] = useState({
    placement: preferred,
    maxHeight: null,
    top: 0,
    left: 0,
    width: 0,
    ready: false,
  });
  const rafRef = useRef(0);

  useLayoutEffect(() => {
    if (!open) {
      setState((prev) => (
        prev.ready
          ? { placement: preferred, maxHeight: null, top: 0, left: 0, width: 0, ready: false }
          : prev
      ));
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      return undefined;
    }

    function measure() {
      // Fall back to the popover's parent when no explicit anchor is supplied —
      // covers MentionPicker callers that don't own a stable trigger ref.
      const anchor = anchorRef?.current || popoverRef?.current?.parentElement;
      if (!anchor || typeof anchor.getBoundingClientRect !== "function") return;
      const anchorRect = anchor.getBoundingClientRect();
      const popoverEl = popoverRef?.current;
      const popoverRect = popoverEl && typeof popoverEl.getBoundingClientRect === "function"
        ? popoverEl.getBoundingClientRect()
        : { width: 0, height: 0 };
      const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 0;
      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0;
      const decision = decidePlacement({
        anchorRect,
        popoverHeight: popoverRect.height,
        viewportHeight,
        preferred,
        gap,
        minSpace,
        margin,
      });
      const coords = computeCoords({
        anchorRect,
        placement: decision.placement,
        popoverWidth: popoverRect.width,
        popoverHeight: popoverRect.height,
        viewportWidth,
        viewportHeight,
        gap,
        margin,
      });
      const next = {
        ...decision,
        top: coords.top,
        left: coords.left,
        width: anchorRect.width,
        ready: true,
      };
      setState((prev) => (
        prev.ready
          && prev.placement === next.placement
          && prev.maxHeight === next.maxHeight
          && prev.top === next.top
          && prev.left === next.left
          && prev.width === next.width
          ? prev
          : next
      ));
    }

    measure();
    // Re-measure on the next frame once the popover element is laid out so we
    // can read its real height/width and cap max-height accurately.
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      measure();
    });

    function onScroll() { measure(); }
    function onResize() { measure(); }
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, { capture: true });
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [open, preferred, gap, minSpace, margin, anchorRef, popoverRef]);

  return state;
}
