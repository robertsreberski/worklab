export const APP_HEIGHT_VAR = "--app-height";
export const VIEWPORT_HEIGHT_VAR = "--worklab-viewport-height";
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

function px(value) {
  const number = Number(value);
  return `${Math.max(0, Math.round(Number.isFinite(number) ? number : 0))}px`;
}

function positiveRound(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
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
  const textTargetActive = isTextEntryTarget(activeElement);
  // Only trust visualViewport offset/height as a viewport extension when a text input owns
  // the keyboard. After dismiss iOS can briefly leave a non-zero offsetTop; without this
  // gate it would inflate --app-height past the real viewport.
  const appHeight = textTargetActive
    ? Math.max(layoutHeight, visibleHeight + offsetTop)
    : layoutHeight;
  const keyboardHeight = Math.max(0, appHeight - (visibleHeight + offsetTop));
  const keyboardOpen = textTargetActive && keyboardHeight > keyboardThreshold;
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

function forceLayoutAfterKeyboardDismiss(env) {
  // Force a full document reflow. Reflowing only .app-body misses
  // position-fixed overlays like .assistant-dock that draw on top of it.
  void rootForEnv(env)?.offsetHeight;
}

export function applyMobileViewportMetrics(env = globalThis) {
  const root = rootForEnv(env);
  if (!root?.style?.setProperty) return null;

  const win = windowForEnv(env);
  const doc = documentForEnv(env);
  const viewportState = computeViewportState({
    innerHeight: win?.innerHeight,
    clientHeight: doc?.documentElement?.clientHeight,
    visualViewport: win?.visualViewport,
    activeElement: doc?.activeElement,
  });

  const appHeight = viewportState.appHeight;
  if (appHeight > 0) {
    root.style.setProperty(APP_HEIGHT_VAR, px(appHeight));
    root.style.setProperty(VIEWPORT_HEIGHT_VAR, px(appHeight));
  }

  const wasOpen = root.classList?.contains?.("keyboard-open") === true;
  root.classList?.toggle?.("keyboard-open", viewportState.keyboardOpen);
  const justClosed = wasOpen && !viewportState.keyboardOpen;
  if (justClosed) forceLayoutAfterKeyboardDismiss(env);

  if (viewportState.keyboardOpen) {
    root.style.setProperty(VV_HEIGHT_VAR, px(viewportState.visibleHeight));
    root.style.setProperty(VV_OFFSET_VAR, px(viewportState.offsetTop));
    root.style.setProperty(KEYBOARD_HEIGHT_VAR, px(viewportState.keyboardHeight));
  } else {
    root.style.removeProperty?.(VV_HEIGHT_VAR);
    root.style.removeProperty?.(VV_OFFSET_VAR);
    root.style.removeProperty?.(KEYBOARD_HEIGHT_VAR);
  }

  return {
    viewportHeight: appHeight,
    appHeight,
    visibleHeight: viewportState.visibleHeight,
    visualViewportOffsetTop: viewportState.offsetTop,
    keyboardHeight: viewportState.keyboardHeight,
    keyboardOpen: viewportState.keyboardOpen,
    keyboardJustClosed: justClosed,
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

const WATCHDOG_INTERVAL_MS = 200;
const WATCHDOG_MAX_ATTEMPTS = 25; // ~5s — bounded poll while keyboard-open is set

export function installMobileViewportMetrics(env = globalThis) {
  const win = windowForEnv(env);
  const doc = documentForEnv(env);
  if (!win?.addEventListener || !doc?.documentElement) return () => {};
  const root = doc.documentElement;

  let frame = 0;
  const timeouts = new Set();
  let watchdogTimer = null;
  let watchdogAttempts = 0;
  const requestFrame = win.requestAnimationFrame?.bind(win) || ((callback) => win.setTimeout?.(callback, 16));
  const cancelFrame = win.cancelAnimationFrame?.bind(win) || win.clearTimeout?.bind(win);
  const clearTimer = win.clearTimeout?.bind(win) || clearTimeout;
  const setTimer = win.setTimeout?.bind(win) || setTimeout;

  const isKeyboardOpenClass = () => root.classList?.contains?.("keyboard-open") === true;

  const stopWatchdog = () => {
    if (watchdogTimer != null) {
      clearTimer(watchdogTimer);
      watchdogTimer = null;
    }
    watchdogAttempts = 0;
  };

  const tickWatchdog = () => {
    watchdogTimer = null;
    if (!isKeyboardOpenClass()) {
      watchdogAttempts = 0;
      return;
    }
    watchdogAttempts += 1;
    applyMobileViewportMetrics(env);
    if (watchdogAttempts >= WATCHDOG_MAX_ATTEMPTS) {
      // Bound the poll so a stuck visualViewport state doesn't keep us re-measuring forever.
      watchdogAttempts = 0;
      return;
    }
    if (isKeyboardOpenClass()) {
      watchdogTimer = setTimer(tickWatchdog, WATCHDOG_INTERVAL_MS);
    } else {
      watchdogAttempts = 0;
    }
  };

  const ensureWatchdog = () => {
    if (!isKeyboardOpenClass()) {
      stopWatchdog();
      return;
    }
    if (watchdogTimer != null) return;
    watchdogAttempts = 0;
    watchdogTimer = setTimer(tickWatchdog, WATCHDOG_INTERVAL_MS);
  };

  const refresh = () => {
    frame = 0;
    applyMobileViewportMetrics(env);
    ensureWatchdog();
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
  // Skip visualViewport scroll while the keyboard is open — iOS fires tiny offsetTop
  // shifts during text entry that would cause a measurement feedback loop.
  const scheduleVisualScroll = () => {
    if (!isKeyboardOpenClass()) scheduleFrame();
  };

  // Proactive cleanup: when focus leaves a text input and no other text-entry target
  // takes its place, force-clear .keyboard-open and the --vv-* vars *immediately* even
  // if iOS hasn't yet fired visualViewport.resize for the dismissal. This is the path
  // the entire app's CSS depends on (body/#app/.app-body/.assistant-dock all gate
  // their layout on the class), so leaving it stuck breaks every responsive surface.
  const clearKeyboardStateIfBlurred = () => {
    if (isTextEntryTarget(doc.activeElement)) return;
    if (!isKeyboardOpenClass()) return;
    root.classList.remove?.("keyboard-open");
    root.style.removeProperty?.(VV_HEIGHT_VAR);
    root.style.removeProperty?.(VV_OFFSET_VAR);
    root.style.removeProperty?.(KEYBOARD_HEIGHT_VAR);
    stopWatchdog();
    void root.offsetHeight;
  };

  const handleFocusOut = () => {
    // Defer one frame so iOS finishes updating document.activeElement.
    requestFrame(() => {
      clearKeyboardStateIfBlurred();
      applyMobileViewportMetrics(env);
      ensureWatchdog();
    });
  };

  // While keyboard-open, any user interaction can prompt iOS to flush its pending
  // visualViewport.resize. Re-measuring on these catches Done-button / swipe-down
  // dismissals where focus stays on the input but iOS lazy-reports the new height.
  const handleInteraction = () => {
    if (!isKeyboardOpenClass()) return;
    scheduleFrame();
  };

  refresh();
  schedule([120, 360]);

  win.addEventListener("resize", scheduleSettled, { passive: true });
  win.addEventListener("orientationchange", scheduleSettled, { passive: true });
  win.addEventListener("pageshow", scheduleResume, { passive: true });
  doc.addEventListener?.("visibilitychange", scheduleResume, { passive: true });
  doc.addEventListener?.("focusin", scheduleSettled, true);
  doc.addEventListener?.("focusout", handleFocusOut, true);
  doc.addEventListener?.("touchend", handleInteraction, { passive: true, capture: true });
  doc.addEventListener?.("pointerup", handleInteraction, { passive: true, capture: true });
  win.visualViewport?.addEventListener?.("resize", scheduleSettled, { passive: true });
  win.visualViewport?.addEventListener?.("scroll", scheduleVisualScroll, { passive: true });
  const removeTouchBoundaryGuard = installTouchBoundaryGuard(env);

  return () => {
    if (frame && cancelFrame) cancelFrame(frame);
    frame = 0;
    stopWatchdog();
    for (const timeout of timeouts) clearTimer(timeout);
    timeouts.clear();
    win.removeEventListener?.("resize", scheduleSettled);
    win.removeEventListener?.("orientationchange", scheduleSettled);
    win.removeEventListener?.("pageshow", scheduleResume);
    doc.removeEventListener?.("visibilitychange", scheduleResume);
    doc.removeEventListener?.("focusin", scheduleSettled, true);
    doc.removeEventListener?.("focusout", handleFocusOut, true);
    doc.removeEventListener?.("touchend", handleInteraction, true);
    doc.removeEventListener?.("pointerup", handleInteraction, true);
    win.visualViewport?.removeEventListener?.("resize", scheduleSettled);
    win.visualViewport?.removeEventListener?.("scroll", scheduleVisualScroll);
    removeTouchBoundaryGuard();
    root.classList?.remove?.("keyboard-open");
    root.style.removeProperty?.(VV_HEIGHT_VAR);
    root.style.removeProperty?.(VV_OFFSET_VAR);
    root.style.removeProperty?.(KEYBOARD_HEIGHT_VAR);
  };
}
