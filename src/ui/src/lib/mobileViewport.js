export const MOBILE_VIEWPORT_CACHE_KEY = "worklab.mobileViewportInsets.v1";
export const APP_HEIGHT_VAR = "--app-height";
export const VIEWPORT_HEIGHT_VAR = "--worklab-viewport-height";
export const SAFE_AREA_TOP_VAR = "--worklab-safe-area-top";
export const SAFE_AREA_BOTTOM_VAR = "--worklab-safe-area-bottom";
export const VV_HEIGHT_VAR = "--vv-height";
export const VV_OFFSET_VAR = "--vv-offset";
export const KEYBOARD_HEIGHT_VAR = "--worklab-keyboard-height";

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function windowForEnv(env) {
  return env?.window || env;
}

function documentForEnv(env) {
  return env?.document || windowForEnv(env)?.document;
}

function rootForEnv(env) {
  return documentForEnv(env)?.documentElement || null;
}

function parsePx(value) {
  const number = Number.parseFloat(String(value || ""));
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function px(value) {
  const number = Number(value);
  return `${Math.max(0, Math.round(Number.isFinite(number) ? number : 0))}px`;
}

function positiveRound(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function safeStorage(env) {
  try {
    return windowForEnv(env)?.localStorage || null;
  } catch {
    return null;
  }
}

function readCachedInsets(env) {
  try {
    const raw = safeStorage(env)?.getItem?.(MOBILE_VIEWPORT_CACHE_KEY);
    if (!raw) return { top: 0, bottom: 0 };
    const parsed = JSON.parse(raw);
    return {
      top: parsePx(parsed?.top),
      bottom: parsePx(parsed?.bottom),
    };
  } catch {
    return { top: 0, bottom: 0 };
  }
}

function writeCachedInsets(env, insets) {
  try {
    safeStorage(env)?.setItem?.(MOBILE_VIEWPORT_CACHE_KEY, JSON.stringify({
      top: parsePx(insets?.top),
      bottom: parsePx(insets?.bottom),
    }));
  } catch {}
}

export function isStandalonePwa(env = globalThis) {
  const win = windowForEnv(env);
  try {
    if (win?.navigator?.standalone === true) return true;
    return !!win?.matchMedia?.("(display-mode: standalone)")?.matches;
  } catch {
    return false;
  }
}

export function isTextEntryTarget(target) {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable === true) return true;
  if (typeof target.closest === "function" && target.closest('[contenteditable="true"]')) return true;
  const tag = String(target.tagName || "").toLowerCase();
  if (tag === "textarea") return !target.disabled && !target.readOnly;
  if (tag !== "input") return false;
  const type = String(target.type || "text").toLowerCase();
  return !target.disabled && !target.readOnly && !NON_TEXT_INPUT_TYPES.has(type);
}

export function computeViewportState({
  innerHeight = 0,
  clientHeight = 0,
  visualViewport = null,
  activeElement = null,
  keyboardThreshold = 150,
} = {}) {
  const layoutHeight = Math.max(positiveRound(innerHeight), positiveRound(clientHeight));
  const visibleHeight = positiveRound(visualViewport?.height) || layoutHeight;
  const offsetTop = Math.max(0, Math.round(Number(visualViewport?.offsetTop) || 0));
  const appHeight = Math.max(layoutHeight, visibleHeight + offsetTop);
  const keyboardHeight = Math.max(0, appHeight - (visibleHeight + offsetTop));
  const keyboardOpen = isTextEntryTarget(activeElement) && keyboardHeight > keyboardThreshold;
  return {
    appHeight,
    visibleHeight,
    offsetTop,
    keyboardHeight,
    keyboardOpen,
  };
}

export function currentViewportHeight(env = globalThis) {
  const win = windowForEnv(env);
  const doc = documentForEnv(env);
  return computeViewportState({
    innerHeight: win?.innerHeight,
    clientHeight: doc?.documentElement?.clientHeight,
    visualViewport: win?.visualViewport,
    activeElement: doc?.activeElement,
  }).appHeight;
}

export function measureSafeAreaInsets(env = globalThis) {
  const doc = documentForEnv(env);
  const win = windowForEnv(env);
  if (!doc?.body?.appendChild || !doc?.createElement || !win?.getComputedStyle) {
    return { top: 0, bottom: 0 };
  }

  const probe = doc.createElement("div");
  probe.setAttribute?.("aria-hidden", "true");
  probe.style.cssText = [
    "position: fixed",
    "left: 0",
    "top: 0",
    "width: 0",
    "height: 0",
    "visibility: hidden",
    "pointer-events: none",
    "padding-top: env(safe-area-inset-top, 0px)",
    "padding-bottom: env(safe-area-inset-bottom, 0px)",
  ].join(";");
  doc.body.appendChild(probe);
  const styles = win.getComputedStyle(probe);
  const insets = {
    top: parsePx(styles?.paddingTop),
    bottom: parsePx(styles?.paddingBottom),
  };
  probe.remove?.();
  return insets;
}

function effectiveSafeAreaInsets(env, measured) {
  if (!isStandalonePwa(env)) return measured;

  const cached = readCachedInsets(env);
  const effective = {
    top: measured.top > 0 ? measured.top : cached.top,
    bottom: measured.bottom > 0 ? measured.bottom : cached.bottom,
  };
  if (measured.top > 0 || measured.bottom > 0) {
    writeCachedInsets(env, {
      top: measured.top > 0 ? measured.top : cached.top,
      bottom: measured.bottom > 0 ? measured.bottom : cached.bottom,
    });
  }
  return effective;
}

function applyKeyboardState(root, viewportState) {
  root.classList?.toggle?.("keyboard-open", viewportState.keyboardOpen);
  if (viewportState.keyboardOpen) {
    root.style.setProperty(VV_HEIGHT_VAR, px(viewportState.visibleHeight));
    root.style.setProperty(VV_OFFSET_VAR, px(viewportState.offsetTop));
    root.style.setProperty(KEYBOARD_HEIGHT_VAR, px(viewportState.keyboardHeight));
    return;
  }
  root.style.removeProperty?.(VV_HEIGHT_VAR);
  root.style.removeProperty?.(VV_OFFSET_VAR);
  root.style.removeProperty?.(KEYBOARD_HEIGHT_VAR);
}

export function applyMobileViewportMetrics(env = globalThis) {
  const root = rootForEnv(env);
  if (!root?.style?.setProperty) return null;

  const win = windowForEnv(env);
  const doc = documentForEnv(env);
  const measured = measureSafeAreaInsets(env);
  const safeArea = effectiveSafeAreaInsets(env, measured);
  const viewportState = computeViewportState({
    innerHeight: win?.innerHeight,
    clientHeight: doc?.documentElement?.clientHeight,
    visualViewport: win?.visualViewport,
    activeElement: doc?.activeElement,
  });
  const viewportHeight = viewportState.appHeight;

  root.style.setProperty(APP_HEIGHT_VAR, px(viewportHeight));
  root.style.setProperty(VIEWPORT_HEIGHT_VAR, px(viewportHeight));
  root.style.setProperty(SAFE_AREA_TOP_VAR, px(safeArea.top));
  root.style.setProperty(SAFE_AREA_BOTTOM_VAR, px(safeArea.bottom));
  applyKeyboardState(root, viewportState);

  return {
    viewportHeight,
    appHeight: viewportState.appHeight,
    visibleHeight: viewportState.visibleHeight,
    visualViewportOffsetTop: viewportState.offsetTop,
    keyboardHeight: viewportState.keyboardHeight,
    keyboardOpen: viewportState.keyboardOpen,
    safeAreaTop: safeArea.top,
    safeAreaBottom: safeArea.bottom,
    measuredSafeAreaTop: measured.top,
    measuredSafeAreaBottom: measured.bottom,
    standalone: isStandalonePwa(env),
  };
}

function shouldInstallTouchBoundaryGuard(env) {
  const win = windowForEnv(env);
  const userAgent = String(win?.navigator?.userAgent || "");
  const isIos = /\b(iPad|iPhone|iPod)\b/.test(userAgent)
    || (/\bMacintosh\b/.test(userAgent) && Number(win?.navigator?.maxTouchPoints || 0) > 1);
  return isIos || isStandalonePwa(env);
}

function isScrollableElement(element, win) {
  if (!element || element === documentForEnv(win)?.body) return false;
  const tag = String(element.tagName || "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  const overflowY = win?.getComputedStyle?.(element)?.overflowY;
  return (overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight;
}

function installTouchBoundaryGuard(env) {
  const win = windowForEnv(env);
  const doc = documentForEnv(env);
  if (!shouldInstallTouchBoundaryGuard(env) || !doc?.addEventListener) return () => {};

  let lastTouchX = 0;
  let lastTouchY = 0;
  const onTouchStart = (event) => {
    const touch = event?.touches?.[0];
    lastTouchX = Number(touch?.clientX) || 0;
    lastTouchY = Number(touch?.clientY) || 0;
  };
  const onTouchMove = (event) => {
    const touch = event?.touches?.[0];
    const touchX = Number(touch?.clientX) || lastTouchX;
    const touchY = Number(touch?.clientY) || lastTouchY;
    const deltaX = touchX - lastTouchX;
    const deltaY = touchY - lastTouchY;
    const movingDown = deltaY > 0;
    const movingUp = deltaY < 0;
    lastTouchX = touchX;
    lastTouchY = touchY;
    if (Math.abs(deltaX) > Math.abs(deltaY)) return;

    let element = event?.target;
    while (element && element !== doc.body) {
      if (isScrollableElement(element, win)) {
        if (element.scrollHeight <= element.clientHeight) break;
        const atTop = element.scrollTop <= 0;
        const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
        if ((atTop && movingDown) || (atBottom && movingUp)) event.preventDefault?.();
        return;
      }
      element = element.parentElement;
    }
    event.preventDefault?.();
  };

  doc.addEventListener("touchstart", onTouchStart, { passive: true });
  doc.addEventListener("touchmove", onTouchMove, { passive: false });
  return () => {
    doc.removeEventListener?.("touchstart", onTouchStart);
    doc.removeEventListener?.("touchmove", onTouchMove);
  };
}

export function installMobileViewportMetrics(env = globalThis) {
  const win = windowForEnv(env);
  const doc = documentForEnv(env);
  if (!win?.addEventListener || !doc?.documentElement) return () => {};

  let frame = 0;
  const timeouts = new Set();
  const requestFrame = win.requestAnimationFrame?.bind(win) || ((callback) => win.setTimeout?.(callback, 16));
  const cancelFrame = win.cancelAnimationFrame?.bind(win) || win.clearTimeout?.bind(win);
  const clearTimer = win.clearTimeout?.bind(win) || clearTimeout;
  const setTimer = win.setTimeout?.bind(win) || setTimeout;

  const refresh = () => {
    frame = 0;
    applyMobileViewportMetrics(env);
  };
  const scheduleFrame = () => {
    if (!frame) frame = requestFrame(refresh);
  };
  const schedule = (delays = [0]) => {
    for (const delay of delays) {
      if (delay === 0) {
        if (frame && cancelFrame) cancelFrame(frame);
        frame = requestFrame(refresh);
        continue;
      }
      const timeout = setTimer(() => {
        timeouts.delete(timeout);
        scheduleFrame();
      }, delay);
      timeouts.add(timeout);
    }
  };
  const scheduleSettled = () => schedule([0, 120, 360]);
  const scheduleResume = () => {
    if (doc.visibilityState === "hidden") return;
    schedule([0, 120, 360, 720]);
  };
  const scheduleVisualScroll = () => {
    if (!doc.documentElement.classList?.contains?.("keyboard-open")) scheduleFrame();
  };

  refresh();
  schedule([120, 360]);

  win.addEventListener("resize", scheduleSettled, { passive: true });
  win.addEventListener("orientationchange", scheduleSettled, { passive: true });
  win.addEventListener("pageshow", scheduleResume, { passive: true });
  doc.addEventListener?.("visibilitychange", scheduleResume, { passive: true });
  doc.addEventListener?.("focusin", scheduleSettled, true);
  doc.addEventListener?.("focusout", scheduleSettled, true);
  win.visualViewport?.addEventListener?.("resize", scheduleSettled, { passive: true });
  win.visualViewport?.addEventListener?.("scroll", scheduleVisualScroll, { passive: true });
  const removeTouchBoundaryGuard = installTouchBoundaryGuard(env);

  return () => {
    if (frame && cancelFrame) cancelFrame(frame);
    frame = 0;
    for (const timeout of timeouts) clearTimer(timeout);
    timeouts.clear();
    win.removeEventListener?.("resize", scheduleSettled);
    win.removeEventListener?.("orientationchange", scheduleSettled);
    win.removeEventListener?.("pageshow", scheduleResume);
    doc.removeEventListener?.("visibilitychange", scheduleResume);
    doc.removeEventListener?.("focusin", scheduleSettled, true);
    doc.removeEventListener?.("focusout", scheduleSettled, true);
    win.visualViewport?.removeEventListener?.("resize", scheduleSettled);
    win.visualViewport?.removeEventListener?.("scroll", scheduleVisualScroll);
    removeTouchBoundaryGuard();
    doc.documentElement.classList?.remove?.("keyboard-open");
    doc.documentElement.style.removeProperty?.(VV_HEIGHT_VAR);
    doc.documentElement.style.removeProperty?.(VV_OFFSET_VAR);
    doc.documentElement.style.removeProperty?.(KEYBOARD_HEIGHT_VAR);
  };
}
