import { describe, expect, it } from "vitest";
import {
  APP_HEIGHT_VAR,
  KEYBOARD_HEIGHT_VAR,
  MOBILE_VIEWPORT_CACHE_KEY,
  SAFE_AREA_BOTTOM_VAR,
  SAFE_AREA_TOP_VAR,
  VV_HEIGHT_VAR,
  VV_OFFSET_VAR,
  VIEWPORT_HEIGHT_VAR,
  applyMobileViewportMetrics,
  computeViewportState,
  installMobileViewportMetrics,
  isStandalonePwa,
  isTextEntryTarget,
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
    removeProperty(name) {
      delete values[name];
    },
  };
}

function createClassList() {
  const values = new Set();
  return {
    values,
    add(name) {
      values.add(name);
    },
    remove(name) {
      values.delete(name);
    },
    contains(name) {
      return values.has(name);
    },
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : !!force;
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
  };
}

function createEnv({
  innerHeight = 844,
  visualHeight,
  visualOffsetTop = 0,
  standalone = false,
  safeTop = 0,
  safeBottom = 0,
  cachedInsets,
  activeElement = null,
  userAgent = "",
  maxTouchPoints = 0,
} = {}) {
  const listeners = new Map();
  const timers = new Map();
  const storage = new Map();
  let timerId = 0;
  if (cachedInsets) storage.set(MOBILE_VIEWPORT_CACHE_KEY, JSON.stringify(cachedInsets));

  const rootStyle = createStyle();
  const rootClassList = createClassList();
  const elements = [];
  const addListener = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  };
  const removeListener = (type, listener) => {
    listeners.get(type)?.delete(listener);
  };
  const env = {
    innerHeight,
    visualViewport: {
      height: visualHeight,
      offsetTop: visualOffsetTop,
      addEventListener(type, listener) {
        addListener(`visual:${type}`, listener);
      },
      removeEventListener(type, listener) {
        removeListener(`visual:${type}`, listener);
      },
    },
    navigator: { standalone, userAgent, maxTouchPoints },
    document: {
      activeElement,
      visibilityState: "visible",
      documentElement: {
        clientHeight: innerHeight,
        style: rootStyle,
        classList: rootClassList,
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
      addEventListener(type, listener) {
        addListener(`document:${type}`, listener);
      },
      removeEventListener(type, listener) {
        removeListener(`document:${type}`, listener);
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
      };
    },
    addEventListener(type, listener) {
      addListener(type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(type, listener);
    },
    requestAnimationFrame(callback) {
      env.pendingFrame = callback;
      return 1;
    },
    cancelAnimationFrame() {
      env.pendingFrame = null;
    },
    setTimeout(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    emit(type) {
      for (const listener of listeners.get(type) || []) listener({ type });
    },
    emitDocument(type) {
      for (const listener of listeners.get(`document:${type}`) || []) listener({ type });
    },
    emitVisual(type) {
      for (const listener of listeners.get(`visual:${type}`) || []) listener({ type });
    },
    flushFrame() {
      const callback = env.pendingFrame;
      env.pendingFrame = null;
      callback?.();
    },
    flushTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    setActiveElement(element) {
      env.document.activeElement = element;
    },
    rootStyle,
    rootClassList,
    storage,
    timers,
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

  it("identifies real text-entry targets for keyboard viewport handling", () => {
    expect(isTextEntryTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "email" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntryTarget({ isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "TEXTAREA", readOnly: true })).toBe(false);
    expect(isTextEntryTarget({ tagName: "INPUT", type: "text", disabled: true })).toBe(false);
  });

  it("keeps the app height anchored when visual viewport shrink is keyboard-driven", () => {
    const state = computeViewportState({
      innerHeight: 844,
      clientHeight: 844,
      visualViewport: { height: 520, offsetTop: 0 },
      activeElement: { tagName: "TEXTAREA" },
    });

    expect(state).toMatchObject({
      appHeight: 844,
      visibleHeight: 520,
      offsetTop: 0,
      keyboardHeight: 324,
      keyboardOpen: true,
    });
  });

  it("does not treat visual viewport shrink as keyboard state without a text target", () => {
    expect(computeViewportState({
      innerHeight: 844,
      clientHeight: 844,
      visualViewport: { height: 520, offsetTop: 0 },
      activeElement: { tagName: "INPUT", type: "checkbox" },
    }).keyboardOpen).toBe(false);
    expect(computeViewportState({
      innerHeight: 844,
      clientHeight: 844,
      visualViewport: { height: 520, offsetTop: 0 },
      activeElement: null,
    }).keyboardOpen).toBe(false);
  });

  it("uses cached standalone safe-area values when first measurement is zero", () => {
    const env = createEnv({
      standalone: true,
      innerHeight: 844,
      safeTop: 0,
      safeBottom: 0,
      cachedInsets: { top: 31, bottom: 11 },
    });

    const metrics = applyMobileViewportMetrics(env);

    expect(metrics).toMatchObject({
      viewportHeight: 844,
      safeAreaTop: 31,
      safeAreaBottom: 11,
      measuredSafeAreaTop: 0,
      measuredSafeAreaBottom: 0,
      standalone: true,
      keyboardOpen: false,
    });
    expect(env.rootStyle.values[APP_HEIGHT_VAR]).toBe("844px");
    expect(env.rootStyle.values[VIEWPORT_HEIGHT_VAR]).toBe("844px");
    expect(env.rootStyle.values[SAFE_AREA_TOP_VAR]).toBe("31px");
    expect(env.rootStyle.values[SAFE_AREA_BOTTOM_VAR]).toBe("11px");
    expect(env.rootStyle.values[KEYBOARD_HEIGHT_VAR]).toBeUndefined();
    expect(env.rootClassList.contains("keyboard-open")).toBe(false);
  });

  it("stores measured non-zero safe-area values for future PWA reloads", () => {
    const env = createEnv({
      standalone: true,
      innerHeight: 844,
      safeTop: 31,
      safeBottom: 11,
    });

    applyMobileViewportMetrics(env);

    expect(JSON.parse(env.storage.get(MOBILE_VIEWPORT_CACHE_KEY))).toEqual({ top: 31, bottom: 11 });
  });

  it("batches viewport refreshes from resize events", () => {
    const env = createEnv({ innerHeight: 844, safeTop: 31, safeBottom: 11 });
    const cleanup = installMobileViewportMetrics(env);

    expect(env.rootStyle.values[VIEWPORT_HEIGHT_VAR]).toBe("844px");
    env.innerHeight = 812;
    env.document.documentElement.clientHeight = 812;
    env.visualViewport.height = 812;
    env.emit("resize");
    expect(env.rootStyle.values[VIEWPORT_HEIGHT_VAR]).toBe("844px");

    env.flushFrame();
    expect(env.rootStyle.values[VIEWPORT_HEIGHT_VAR]).toBe("812px");

    cleanup();
  });

  it("adds keyboard viewport variables only when a text field owns the shrink", () => {
    const env = createEnv({
      innerHeight: 844,
      visualHeight: 844,
      activeElement: { tagName: "TEXTAREA" },
    });
    const cleanup = installMobileViewportMetrics(env);

    env.visualViewport.height = 520;
    env.emitVisual("resize");
    env.flushFrame();

    expect(env.rootClassList.contains("keyboard-open")).toBe(true);
    expect(env.rootStyle.values[APP_HEIGHT_VAR]).toBe("844px");
    expect(env.rootStyle.values[VV_HEIGHT_VAR]).toBe("520px");
    expect(env.rootStyle.values[VV_OFFSET_VAR]).toBe("0px");
    expect(env.rootStyle.values[KEYBOARD_HEIGHT_VAR]).toBe("324px");

    env.setActiveElement({ tagName: "INPUT", type: "checkbox" });
    env.emitDocument("focusin");
    env.flushFrame();

    expect(env.rootClassList.contains("keyboard-open")).toBe(false);
    expect(env.rootStyle.values[VV_HEIGHT_VAR]).toBeUndefined();
    expect(env.rootStyle.values[KEYBOARD_HEIGHT_VAR]).toBeUndefined();

    cleanup();
    expect(env.rootClassList.contains("keyboard-open")).toBe(false);
  });

  it("is a no-op without browser document APIs", () => {
    const cleanup = installMobileViewportMetrics({});
    expect(typeof cleanup).toBe("function");
    expect(applyMobileViewportMetrics({})).toBe(null);
  });
});
