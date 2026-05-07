export const MOBILE_VIEWPORT_CACHE_KEY = "worklab.mobileViewportInsets.v1";
export const VIEWPORT_HEIGHT_VAR = "--worklab-viewport-height";
export const SAFE_AREA_TOP_VAR = "--worklab-safe-area-top";
export const SAFE_AREA_BOTTOM_VAR = "--worklab-safe-area-bottom";

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

export function currentViewportHeight(env = globalThis) {
  const win = windowForEnv(env);
  const doc = documentForEnv(env);
  const visualHeight = Number(win?.visualViewport?.height);
  const innerHeight = Number(win?.innerHeight);
  const clientHeight = Number(doc?.documentElement?.clientHeight);
  return Math.max(0, Math.round(
    (Number.isFinite(visualHeight) && visualHeight > 0 && visualHeight)
    || (Number.isFinite(innerHeight) && innerHeight > 0 && innerHeight)
    || (Number.isFinite(clientHeight) && clientHeight > 0 && clientHeight)
    || 0,
  ));
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

export function applyMobileViewportMetrics(env = globalThis) {
  const root = rootForEnv(env);
  if (!root?.style?.setProperty) return null;

  const measured = measureSafeAreaInsets(env);
  const safeArea = effectiveSafeAreaInsets(env, measured);
  const viewportHeight = currentViewportHeight(env);

  root.style.setProperty(VIEWPORT_HEIGHT_VAR, px(viewportHeight));
  root.style.setProperty(SAFE_AREA_TOP_VAR, px(safeArea.top));
  root.style.setProperty(SAFE_AREA_BOTTOM_VAR, px(safeArea.bottom));

  return {
    viewportHeight,
    safeAreaTop: safeArea.top,
    safeAreaBottom: safeArea.bottom,
    measuredSafeAreaTop: measured.top,
    measuredSafeAreaBottom: measured.bottom,
    standalone: isStandalonePwa(env),
  };
}

export function installMobileViewportMetrics(env = globalThis) {
  const win = windowForEnv(env);
  const doc = documentForEnv(env);
  if (!win?.addEventListener || !doc?.documentElement) return () => {};

  let frame = 0;
  const requestFrame = win.requestAnimationFrame?.bind(win) || ((callback) => win.setTimeout?.(callback, 16));
  const cancelFrame = win.cancelAnimationFrame?.bind(win) || win.clearTimeout?.bind(win);

  const refresh = () => {
    frame = 0;
    applyMobileViewportMetrics(env);
  };
  const schedule = () => {
    if (frame) return;
    frame = requestFrame(refresh);
  };

  refresh();

  win.addEventListener("resize", schedule, { passive: true });
  win.addEventListener("orientationchange", schedule, { passive: true });
  win.addEventListener("pageshow", schedule, { passive: true });
  win.visualViewport?.addEventListener?.("resize", schedule, { passive: true });

  return () => {
    if (frame && cancelFrame) cancelFrame(frame);
    frame = 0;
    win.removeEventListener?.("resize", schedule);
    win.removeEventListener?.("orientationchange", schedule);
    win.removeEventListener?.("pageshow", schedule);
    win.visualViewport?.removeEventListener?.("resize", schedule);
  };
}
