export const ASSISTANT_KEYBOARD_LIFT_VAR = "--assistant-keyboard-lift";
export const ASSISTANT_KEYBOARD_FALLBACK_LIFT_VAR = "--assistant-keyboard-fallback-lift";
export const ASSISTANT_KEYBOARD_CLEARANCE = 8;
export const ASSISTANT_KEYBOARD_MEASURED_THRESHOLD = 220;
export const ASSISTANT_KEYBOARD_FALLBACK_MIN = 280;
export const ASSISTANT_KEYBOARD_FALLBACK_MAX = 340;
export const ASSISTANT_KEYBOARD_FALLBACK_RATIO = 0.38;
export const ASSISTANT_KEYBOARD_HEADER_GAP = 12;

function positiveRound(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
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
  keyboardHeight = 0,
  visibleBottom = 0,
  composerBottom = 0,
  textareaBottom = 0,
  currentLift = 0,
  clearance = ASSISTANT_KEYBOARD_CLEARANCE,
} = {}) {
  const lift = positiveRound(currentLift);
  const safeClearance = positiveRound(clearance);
  const targetBottom = positiveRound(visibleBottom);
  const candidates = [positiveRound(keyboardHeight)];

  for (const bottom of [composerBottom, textareaBottom]) {
    const baseBottom = positiveRound(bottom) + lift;
    const overlap = targetBottom > 0 ? Math.max(0, baseBottom - targetBottom) : 0;
    if (overlap > 0) candidates.push(overlap + safeClearance);
  }

  return Math.max(0, ...candidates.map(positiveRound));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function computeAssistantKeyboardFallbackLift({
  dockHeight = 0,
  dockBottom = 0,
  composerTop = 0,
  composerBottom = 0,
  currentLift = 0,
  headerBottom = 0,
  clearance = ASSISTANT_KEYBOARD_CLEARANCE,
  minFallback = ASSISTANT_KEYBOARD_FALLBACK_MIN,
  maxFallback = ASSISTANT_KEYBOARD_FALLBACK_MAX,
  fallbackRatio = ASSISTANT_KEYBOARD_FALLBACK_RATIO,
  headerGap = ASSISTANT_KEYBOARD_HEADER_GAP,
} = {}) {
  return computeAssistantKeyboardFallbackState({
    dockHeight,
    dockBottom,
    composerTop,
    composerBottom,
    currentLift,
    headerBottom,
    clearance,
    minFallback,
    maxFallback,
    fallbackRatio,
    headerGap,
  }).fallbackLift;
}

export function computeAssistantKeyboardFallbackState({
  dockHeight = 0,
  dockBottom = 0,
  composerTop = 0,
  composerBottom = 0,
  currentLift = 0,
  headerBottom = 0,
  clearance = ASSISTANT_KEYBOARD_CLEARANCE,
  minFallback = ASSISTANT_KEYBOARD_FALLBACK_MIN,
  maxFallback = ASSISTANT_KEYBOARD_FALLBACK_MAX,
  fallbackRatio = ASSISTANT_KEYBOARD_FALLBACK_RATIO,
  headerGap = ASSISTANT_KEYBOARD_HEADER_GAP,
} = {}) {
  const height = positiveRound(dockHeight);
  const estimatedKeyboardHeight = clamp(positiveRound(height * fallbackRatio), positiveRound(minFallback), positiveRound(maxFallback));
  const fallbackTargetBottom = Math.max(0, positiveRound(dockBottom) - estimatedKeyboardHeight);
  const baseComposerBottom = positiveRound(composerBottom) + positiveRound(currentLift);
  const desiredLift = fallbackTargetBottom > 0 && baseComposerBottom > 0
    ? Math.max(0, baseComposerBottom - fallbackTargetBottom + positiveRound(clearance))
    : 0;
  const baseComposerTop = positiveRound(composerTop) + positiveRound(currentLift);
  const headerLimit = positiveRound(headerBottom) + positiveRound(headerGap);
  const maxLift = baseComposerTop && headerLimit ? Math.max(0, baseComposerTop - headerLimit) : desiredLift;
  return {
    estimatedKeyboardHeight,
    fallbackTargetBottom,
    fallbackLift: Math.max(0, Math.min(desiredLift, maxLift)),
  };
}

export function computeAssistantKeyboardLiftState({
  dockBottom = 0,
  composerFocused = false,
  mobileLayout = false,
  measuredThreshold = ASSISTANT_KEYBOARD_MEASURED_THRESHOLD,
  ...options
} = {}) {
  const measuredLift = computeAssistantKeyboardLift(options);
  const fallbackState = computeAssistantKeyboardFallbackState({ ...options, dockBottom });
  const { fallbackLift, estimatedKeyboardHeight, fallbackTargetBottom } = fallbackState;
  const visibleBottom = positiveRound(options.visibleBottom);
  const hiddenHeight = Math.max(0, positiveRound(dockBottom) - visibleBottom);

  if (hiddenHeight >= positiveRound(measuredThreshold) && measuredLift > 0) {
    return { lift: measuredLift, mode: "measured", measuredLift, fallbackLift, hiddenHeight, estimatedKeyboardHeight, fallbackTargetBottom };
  }

  if (composerFocused && mobileLayout && fallbackLift > 0) {
    return { lift: fallbackLift, mode: "fallback", measuredLift, fallbackLift, hiddenHeight, estimatedKeyboardHeight, fallbackTargetBottom };
  }

  if (measuredLift > 0) {
    return { lift: measuredLift, mode: "measured", measuredLift, fallbackLift, hiddenHeight, estimatedKeyboardHeight, fallbackTargetBottom };
  }

  return { lift: 0, mode: "none", measuredLift, fallbackLift, hiddenHeight, estimatedKeyboardHeight, fallbackTargetBottom };
}
