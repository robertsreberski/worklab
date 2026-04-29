export const ASSISTANT_WIDTH_STORAGE_KEY = "worklab.assistantDockWidth";
export const ASSISTANT_WIDTH_DEFAULT = 320;
export const ASSISTANT_WIDTH_MIN = 320;
export const ASSISTANT_WIDTH_MAX = 680;
export const ASSISTANT_MOBILE_BREAKPOINT = 860;

const ASSISTANT_RAIL_BREAKPOINT = 1180;
const ASSISTANT_WIDE_RAIL_WIDTH = 224;
const ASSISTANT_NARROW_RAIL_WIDTH = 64;
const ASSISTANT_MAIN_MIN_WIDTH = 520;

function numericWidth(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return NaN;
  return Number.parseFloat(value);
}

export function assistantMaxWidthForViewport(viewportWidth) {
  const width = Number(viewportWidth);
  if (!Number.isFinite(width) || width <= ASSISTANT_MOBILE_BREAKPOINT) {
    return ASSISTANT_WIDTH_MAX;
  }
  const railWidth = width <= ASSISTANT_RAIL_BREAKPOINT
    ? ASSISTANT_NARROW_RAIL_WIDTH
    : ASSISTANT_WIDE_RAIL_WIDTH;
  const viewportMax = Math.floor(width - railWidth - ASSISTANT_MAIN_MIN_WIDTH);
  return Math.max(ASSISTANT_WIDTH_MIN, Math.min(ASSISTANT_WIDTH_MAX, viewportMax));
}

export function clampAssistantWidth(value, viewportWidth) {
  const width = numericWidth(value);
  const target = Number.isFinite(width) ? width : ASSISTANT_WIDTH_DEFAULT;
  return Math.round(Math.max(
    ASSISTANT_WIDTH_MIN,
    Math.min(target, assistantMaxWidthForViewport(viewportWidth)),
  ));
}

export function assistantWidthFromStorage(storage, viewportWidth) {
  let stored;
  try {
    stored = storage?.getItem?.(ASSISTANT_WIDTH_STORAGE_KEY);
  } catch {
    stored = null;
  }
  return clampAssistantWidth(stored || ASSISTANT_WIDTH_DEFAULT, viewportWidth);
}

export function assistantInitialWidth(env = globalThis) {
  let storage = null;
  try {
    storage = env?.localStorage || null;
  } catch {
    storage = null;
  }
  return assistantWidthFromStorage(storage, env?.innerWidth);
}
