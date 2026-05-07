import { describe, expect, it } from "vitest";
import {
  MOBILE_VIEWPORT_CACHE_KEY,
  SAFE_AREA_BOTTOM_VAR,
  SAFE_AREA_TOP_VAR,
  VIEWPORT_HEIGHT_VAR,
  applyMobileViewportMetrics,
  installMobileViewportMetrics,
  isStandalonePwa,
} from "../../ui/src/lib/mobileViewport.js";

function createStyle(initial = {}) {
  const values = { ...initial };
  return {
    values,
    cssText: "",
    setProperty(name, value) {
      values[name] = value;
    },
    getPropertyValue(name) {
      return values[name] || "";
    },
  };
}

function createEnv({
  innerHeight = 844,
  visualHeight,
  standalone = false,
  safeTop = 0,
  safeBottom = 0,
  safeMaxBottom = 0,
  cachedInsets,
} = {}) {
  const listeners = new Map();
  const storage = new Map();
  if (cachedInsets) storage.set(MOBILE_VIEWPORT_CACHE_KEY, JSON.stringify(cachedInsets));

  const rootStyle = createStyle();
  const elements = [];
  const env = {
    innerHeight,
    visualViewport: {
      height: visualHeight,
      addEventListener(type, listener) {
        listeners.set(`visual:${type}`, listener);
      },
      removeEventListener(type) {
        listeners.delete(`visual:${type}`);
      },
    },
    navigator: { standalone },
    document: {
      documentElement: {
        clientHeight: innerHeight,
        style: rootStyle,
      },
      body: {
        appendChild(node) {
          elements.push(node);
          node.remove = () => {
            const index = elements.indexOf(node);
            if (index !== -1) elements.splice(index, 1);
          };
          return node;
        },
      },
      createElement() {
        return {
          style: createStyle(),
          setAttribute() {},
          remove() {},
        };
      },
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    matchMedia(query) {
      return { matches: query === "(display-mode: standalone)" && standalone };
    },
    getComputedStyle() {
      return {
        paddingTop: `${safeTop}px`,
        paddingBottom: `${safeBottom}px`,
        marginBottom: `${safeMaxBottom}px`,
      };
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    requestAnimationFrame(callback) {
      env.pendingFrame = callback;
      return 1;
    },
    cancelAnimationFrame() {
      env.pendingFrame = null;
    },
    emit(type) {
      listeners.get(type)?.({ type });
    },
    emitVisual(type) {
      listeners.get(`visual:${type}`)?.({ type });
    },
    flushFrame() {
      const callback = env.pendingFrame;
      env.pendingFrame = null;
      callback?.();
    },
    rootStyle,
    storage,
    pendingFrame: null,
  };
  env.window = env;
  return env;
}

describe("mobile viewport metrics", () => {
  it("detects iOS standalone mode", () => {
    expect(isStandalonePwa(createEnv({ standalone: true }))).toBe(true);
    expect(isStandalonePwa(createEnv({ standalone: false }))).toBe(false);
  });

  it("uses cached standalone safe-area values when first measurement is zero", () => {
    const env = createEnv({
      standalone: true,
      innerHeight: 844,
      safeTop: 0,
      safeBottom: 0,
      cachedInsets: { top: 31, bottom: 11, maxBottom: 21 },
    });

    const metrics = applyMobileViewportMetrics(env);

    expect(metrics).toMatchObject({
      viewportHeight: 844,
      safeAreaTop: 31,
      safeAreaBottom: 21,
      measuredSafeAreaTop: 0,
      measuredSafeAreaBottom: 0,
      measuredSafeAreaMaxBottom: 0,
      standalone: true,
    });
    expect(env.rootStyle.values[VIEWPORT_HEIGHT_VAR]).toBe("844px");
    expect(env.rootStyle.values[SAFE_AREA_TOP_VAR]).toBe("31px");
    expect(env.rootStyle.values[SAFE_AREA_BOTTOM_VAR]).toBe("21px");
  });

  it("stores measured non-zero safe-area values for future PWA reloads", () => {
    const env = createEnv({
      standalone: true,
      innerHeight: 844,
      safeTop: 31,
      safeBottom: 11,
      safeMaxBottom: 21,
    });

    applyMobileViewportMetrics(env);

    expect(JSON.parse(env.storage.get(MOBILE_VIEWPORT_CACHE_KEY))).toEqual({ top: 31, bottom: 11, maxBottom: 21 });
  });

  it("uses max safe-area bottom when the dynamic inset is smaller", () => {
    const env = createEnv({
      innerHeight: 844,
      safeTop: 31,
      safeBottom: 4,
      safeMaxBottom: 21,
    });

    const metrics = applyMobileViewportMetrics(env);

    expect(metrics).toMatchObject({
      safeAreaBottom: 21,
      measuredSafeAreaBottom: 4,
      measuredSafeAreaMaxBottom: 21,
    });
    expect(env.rootStyle.values[SAFE_AREA_BOTTOM_VAR]).toBe("21px");
  });

  it("falls back to dynamic safe-area bottom when max inset is unavailable", () => {
    const env = createEnv({
      innerHeight: 844,
      safeBottom: 11,
      safeMaxBottom: 0,
    });

    applyMobileViewportMetrics(env);

    expect(env.rootStyle.values[SAFE_AREA_BOTTOM_VAR]).toBe("11px");
  });

  it("batches viewport refreshes from resize events", () => {
    const env = createEnv({ innerHeight: 844, safeTop: 31, safeBottom: 11 });
    const cleanup = installMobileViewportMetrics(env);

    expect(env.rootStyle.values[VIEWPORT_HEIGHT_VAR]).toBe("844px");
    env.innerHeight = 812;
    env.visualViewport.height = 812;
    env.emit("resize");
    expect(env.rootStyle.values[VIEWPORT_HEIGHT_VAR]).toBe("844px");

    env.flushFrame();
    expect(env.rootStyle.values[VIEWPORT_HEIGHT_VAR]).toBe("812px");

    cleanup();
  });

  it("is a no-op without browser document APIs", () => {
    const cleanup = installMobileViewportMetrics({});
    expect(typeof cleanup).toBe("function");
    expect(applyMobileViewportMetrics({})).toBe(null);
  });
});
