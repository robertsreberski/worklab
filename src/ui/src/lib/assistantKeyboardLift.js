export const ASSISTANT_KEYBOARD_LIFT_VAR = "--assistant-keyboard-lift";
export const ASSISTANT_KEYBOARD_CLEARANCE = 8;

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
