export const ASSISTANT_KEYBOARD_LIFT_VAR = "--assistant-keyboard-lift";
const ASSISTANT_KEYBOARD_CLEARANCE = 8;
const ASSISTANT_KEYBOARD_RESCUE_MIN = 56;
const ASSISTANT_KEYBOARD_RESCUE_MAX = 96;
const ASSISTANT_KEYBOARD_RESCUE_EXTRA = 12;
const ASSISTANT_KEYBOARD_RESCUE_NO_SIGNAL_MAX = 80;
const ASSISTANT_KEYBOARD_RESCUE_DANGER_ZONE = 120;

function positiveRound(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function readCssPxValue(value) {
  const number = parseFloat(String(value || "").trim());
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function cssPx(value) {
  return `${positiveRound(value)}px`;
}

export function visualViewportBottom(win = globalThis) {
  const vv = win?.visualViewport;
  const visibleHeight = positiveRound(vv?.height) || positiveRound(win?.innerHeight);
  const offsetTop = Math.max(0, Math.round(Number(vv?.offsetTop) || 0));
  return visibleHeight + offsetTop;
}

export function computeAssistantKeyboardLift({
  visibleBottom = 0,
  composerBottom = 0,
  textareaBottom = 0,
  currentLift = 0,
  clearance = ASSISTANT_KEYBOARD_CLEARANCE,
} = {}) {
  const lift = positiveRound(currentLift);
  const safeClearance = positiveRound(clearance);
  const targetBottom = positiveRound(visibleBottom);
  const candidates = [0];

  for (const bottom of [composerBottom, textareaBottom]) {
    const baseBottom = positiveRound(bottom) + lift;
    const overlap = targetBottom > 0 ? Math.max(0, baseBottom - targetBottom) : 0;
    if (overlap > 0) candidates.push(overlap + safeClearance);
  }

  return Math.max(0, ...candidates.map(positiveRound));
}

function computeAssistantKeyboardRescueLift({
  visibleBottom = 0,
  dockBottom = 0,
  composerBottom = 0,
  currentLift = 0,
  textareaHeight = 0,
  safeAreaBottom = 0,
  mobileLayout = false,
  noSignalMax = ASSISTANT_KEYBOARD_RESCUE_NO_SIGNAL_MAX,
  dangerZone = ASSISTANT_KEYBOARD_RESCUE_DANGER_ZONE,
  minRescue = ASSISTANT_KEYBOARD_RESCUE_MIN,
  maxRescue = ASSISTANT_KEYBOARD_RESCUE_MAX,
  rescueExtra = ASSISTANT_KEYBOARD_RESCUE_EXTRA,
} = {}) {
  if (!mobileLayout) return 0;

  const dockEdge = positiveRound(dockBottom);
  const viewportEdge = positiveRound(visibleBottom);
  const hiddenHeight = Math.max(0, dockEdge - viewportEdge);
  if (!dockEdge || !viewportEdge || hiddenHeight > positiveRound(noSignalMax)) return 0;

  const baseComposerBottom = positiveRound(composerBottom) + positiveRound(currentLift);
  if (!baseComposerBottom) return 0;
  if (baseComposerBottom < dockEdge - positiveRound(dangerZone)) return 0;

  const rawLift = positiveRound(textareaHeight) + positiveRound(safeAreaBottom) + positiveRound(rescueExtra);
  if (!rawLift) return 0;
  return clamp(rawLift, positiveRound(minRescue), positiveRound(maxRescue));
}

export function computeAssistantKeyboardLiftState({
  dockBottom = 0,
  composerFocused = false,
  ...options
} = {}) {
  const measuredLift = computeAssistantKeyboardLift(options);
  const visibleBottom = positiveRound(options.visibleBottom);
  const hiddenHeight = Math.max(0, positiveRound(dockBottom) - visibleBottom);
  const focused = !!composerFocused;
  const rescueLift = focused
    ? computeAssistantKeyboardRescueLift({ ...options, dockBottom })
    : 0;

  if (focused && measuredLift > 0) {
    return { lift: measuredLift, mode: "measured", measuredLift, rescueLift: 0, hiddenHeight };
  }

  if (focused && rescueLift > 0) {
    return { lift: rescueLift, mode: "focus-rescue", measuredLift: 0, rescueLift, hiddenHeight };
  }

  return { lift: 0, mode: "none", measuredLift: 0, rescueLift: 0, hiddenHeight };
}
