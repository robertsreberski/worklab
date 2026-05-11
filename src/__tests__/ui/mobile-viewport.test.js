import { describe, expect, it } from "vitest";
import {
  APP_HEIGHT_VAR,
  KEYBOARD_HEIGHT_VAR,
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
  activeElement = null,
  userAgent = "",
  maxTouchPoints = 0,
} = {}) {
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;

  const rootStyle = createStyle();
  const rootClassList = createClassList();
  const documentElement = {
    clientHeight: innerHeight,
    style: rootStyle,
    classList: rootClassList,
    offsetHeightReads: 0,
  };
  Object.defineProperty(documentElement, "offsetHeight", {
    get() {
      documentElement.offsetHeightReads += 1;
      return innerHeight;
    },
  });
  const body = {
    appendChild() {},
    getBoundingClientRectCalls: 0,
    getBoundingClientRect() {
      body.getBoundingClientRectCalls += 1;
      return {
        x: 0,
        y: 0,
        width: 0,
        height: innerHeight,
        top: 0,
        bottom: innerHeight,
        left: 0,
        right: 0,
      };
    },
  };
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
      documentElement,
      body,
      addEventListener(type, listener) {
        addListener(`document:${type}`, listener);
      },
      removeEventListener(type, listener) {
        removeListener(`document:${type}`, listener);
      },
      querySelector() {
        return null;
      },
    },
    matchMedia(query) {
      if (query === "(display-mode: standalone)") return { matches: standalone };
      return { matches: false };
    },
    getComputedStyleCalls: 0,
    computedReads: 0,
    getComputedStyle(target) {
      env.getComputedStyleCalls += 1;
      const overflowY = target === documentElement ? "visible" : "auto";
      return {
        overflowY,
        getPropertyValue(name) {
          env.computedReads += 1;
          return rootStyle.values[name] || "";
        },
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
    setActiveElement(element) {
      env.document.activeElement = element;
    },
    scrollBy(...args) {
      env.scrollByCalls.push(args);
    },
    scrollByCalls: [],
    rootStyle,
    rootClassList,
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

  it("computes appHeight unconditionally as Math.max(layoutHeight, visibleHeight + offsetTop) — matching mickey-ai", () => {
    // No text input focused, residual offsetTop after keyboard dismiss.
    // Mickey-ai's formula returns the larger value (852); we match that exactly.
    expect(computeViewportState({
      innerHeight: 844,
      clientHeight: 844,
      visualViewport: { height: 844, offsetTop: 8 },
      activeElement: null,
    }).appHeight).toBe(852);

    // With keyboard up: layoutHeight wins because vv.height + offsetTop is smaller.
    expect(computeViewportState({
      innerHeight: 844,
      clientHeight: 844,
      visualViewport: { height: 520, offsetTop: 0 },
      activeElement: { tagName: "TEXTAREA" },
    }).appHeight).toBe(844);

    // keyboardOpen still gates on focused text input — stays focus-aware.
    expect(computeViewportState({
      innerHeight: 844,
      clientHeight: 844,
      visualViewport: { height: 844, offsetTop: 8 },
      activeElement: null,
    }).keyboardOpen).toBe(false);
  });

  it("never writes safe-area or app-height CSS variables to documentElement.style", () => {
    // Safe-area insets are owned entirely by CSS env(). App-height is owned by CSS
    // (100dvh fallback) — JS reads of innerHeight/visualViewport are unreliable
    // across iOS 26 minor versions and would render body shorter than the screen.
    const env = createEnv({
      standalone: true,
      innerHeight: 844,
      visualHeight: 844,
    });

    applyMobileViewportMetrics(env);

    expect(env.rootStyle.values["--worklab-safe-area-top"]).toBeUndefined();
    expect(env.rootStyle.values["--worklab-safe-area-bottom"]).toBeUndefined();
    expect(env.rootStyle.values["--worklab-safe-area-left"]).toBeUndefined();
    expect(env.rootStyle.values["--worklab-safe-area-right"]).toBeUndefined();
    expect(env.rootStyle.values[APP_HEIGHT_VAR]).toBeUndefined();
    expect(env.rootStyle.values[VIEWPORT_HEIGHT_VAR]).toBeUndefined();
  });

  it("batches viewport refreshes from resize events", () => {
    // The runtime no longer JS-sets --app-height / --worklab-viewport-height — body
    // height is CSS-managed (100dvh). We verify the schedule machinery still runs by
    // observing a side-effect that *is* JS-driven: the keyboard-open class toggling
    // when the active element gains focus and visualViewport shrinks.
    const env = createEnv({
      innerHeight: 844,
      visualHeight: 844,
      activeElement: { tagName: "TEXTAREA" },
    });
    const cleanup = installMobileViewportMetrics(env);

    // No app-height var should have been written.
    expect(env.rootStyle.values[VIEWPORT_HEIGHT_VAR]).toBeUndefined();
    expect(env.rootStyle.values[APP_HEIGHT_VAR]).toBeUndefined();

    env.visualViewport.height = 520;
    env.emit("resize");
    // Pre-flush: refresh hasn't run yet.
    expect(env.rootClassList.contains("keyboard-open")).toBe(false);

    env.flushFrame();
    // Post-flush: schedule fired, refresh ran, class toggled.
    expect(env.rootClassList.contains("keyboard-open")).toBe(true);

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
    // --app-height is CSS-managed now (100dvh); JS no longer sets it on root.style.
    expect(env.rootStyle.values[APP_HEIGHT_VAR]).toBeUndefined();
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

  it("force-clears keyboard-open on focusout when no text input remains focused, even with stale visualViewport", () => {
    const env = createEnv({
      innerHeight: 844,
      visualHeight: 844,
      activeElement: { tagName: "TEXTAREA" },
    });
    const cleanup = installMobileViewportMetrics(env);

    // Bring the keyboard up.
    env.visualViewport.height = 520;
    env.emitVisual("resize");
    env.flushFrame();
    expect(env.rootClassList.contains("keyboard-open")).toBe(true);
    expect(env.rootStyle.values[VV_HEIGHT_VAR]).toBe("520px");

    // User dismisses the keyboard via Done / tap-outside; activeElement is no longer
    // a text input but iOS hasn't fired visualViewport.resize yet (vv.height stays 520).
    env.setActiveElement(null);
    env.emitDocument("focusout");
    env.flushFrame();

    expect(env.rootClassList.contains("keyboard-open")).toBe(false);
    expect(env.rootStyle.values[VV_HEIGHT_VAR]).toBeUndefined();
    expect(env.rootStyle.values[VV_OFFSET_VAR]).toBeUndefined();
    expect(env.rootStyle.values[KEYBOARD_HEIGHT_VAR]).toBeUndefined();

    cleanup();
  });

  it("starts a watchdog timer while keyboard-open and clears it once the state flips", () => {
    const env = createEnv({
      innerHeight: 844,
      visualHeight: 844,
      activeElement: { tagName: "TEXTAREA" },
    });
    const cleanup = installMobileViewportMetrics(env);

    // Initial idle: no watchdog yet.
    env.flushFrame();
    expect(env.rootClassList.contains("keyboard-open")).toBe(false);

    // Open the keyboard — watchdog should be scheduled in env.timers.
    env.visualViewport.height = 520;
    env.emitVisual("resize");
    env.flushFrame();
    expect(env.rootClassList.contains("keyboard-open")).toBe(true);
    // env.timers contains both the [120, 360] schedule and the watchdog timer.
    expect(env.timers.size).toBeGreaterThan(0);

    // Close the keyboard via blur. The proactive clear strips the class; the next
    // refresh stops the watchdog.
    env.setActiveElement(null);
    env.visualViewport.height = 844;
    env.emitDocument("focusout");
    env.flushFrame();
    expect(env.rootClassList.contains("keyboard-open")).toBe(false);

    cleanup();
    expect(env.timers.size).toBe(0);
  });

  it("force-scrolls 1px on focusout to unstick visualViewport on iOS 26.0", () => {
    const env = createEnv({
      innerHeight: 844,
      visualHeight: 844,
      activeElement: { tagName: "TEXTAREA" },
    });
    const cleanup = installMobileViewportMetrics(env);

    // Open the keyboard.
    env.visualViewport.height = 520;
    env.emitVisual("resize");
    env.flushFrame();

    // User dismisses via Done (focus moves to body).
    env.scrollByCalls.length = 0;
    env.setActiveElement(null);
    env.emitDocument("focusout");
    env.flushFrame();

    // The 100ms unstick timer should be queued in the env's mocked timers.
    expect(env.timers.size).toBeGreaterThan(0);

    // Run the queued timer — this triggers unstickVisualViewport which calls
    // window.scrollBy(0, -1) followed by window.scrollBy(0, 1).
    const callbacks = [...env.timers.values()];
    env.timers.clear();
    for (const cb of callbacks) cb();
    env.flushFrame();

    expect(env.scrollByCalls).toEqual([[0, -1], [0, 1]]);

    cleanup();
  });

  it("force-blurs the focused text input when a tap lands outside it while keyboard-open is set", () => {
    let blurredElement = null;
    const textarea = {
      tagName: "TEXTAREA",
      blur() {
        blurredElement = this;
      },
      contains() {
        return false;
      },
    };
    const env = createEnv({
      innerHeight: 844,
      visualHeight: 844,
      activeElement: textarea,
    });
    const cleanup = installMobileViewportMetrics(env);

    // Bring up the keyboard.
    env.visualViewport.height = 520;
    env.emitVisual("resize");
    env.flushFrame();
    expect(env.rootClassList.contains("keyboard-open")).toBe(true);

    // Tap outside the focused textarea — the runtime should force-blur so iOS
    // dismisses cleanly. (createEnv's emitDocument fires the handler; with no
    // target on the synthetic event the contains() check returns false → outside.)
    env.emitDocument("touchend");
    expect(blurredElement).toBe(textarea);

    cleanup();
  });

  it("ticks a periodic viewport-reflow timer while in standalone PWA mode", () => {
    // iOS 26.2+ standalone PWAs lazy-evaluate 100vh against a stale layout viewport;
    // a 1Hz forced reflow + style read on the viewport-height chain keeps body sized
    // to the screen. The empirical fix originally came from ?debug-viewport=1's
    // setInterval(refresh, 1000); this test guards the productionized version.
    const env = createEnv({ standalone: true });
    const cleanup = installMobileViewportMetrics(env);

    // Drain the synchronous initial schedule so we start from a clean tick state.
    env.flushFrame();
    const baselineOffsetReads = env.document.documentElement.offsetHeightReads;
    const baselineRectCalls = env.document.body.getBoundingClientRectCalls;
    const baselineComputed = env.getComputedStyleCalls;
    const baselineTimers = env.timers.size;
    expect(baselineTimers).toBeGreaterThan(0);

    // The most recently enqueued timer at install time is the reflow tick.
    const lastTimerId = Math.max(...env.timers.keys());
    const tick = env.timers.get(lastTimerId);
    env.timers.delete(lastTimerId);

    tick();

    expect(env.document.documentElement.offsetHeightReads).toBeGreaterThan(baselineOffsetReads);
    expect(env.document.body.getBoundingClientRectCalls).toBeGreaterThan(baselineRectCalls);
    expect(env.getComputedStyleCalls).toBeGreaterThan(baselineComputed);
    // Tick re-schedules itself so the reflow keeps firing.
    expect(env.timers.size).toBe(baselineTimers);

    cleanup();
    expect(env.timers.size).toBe(0);
  });

  it("does not start the viewport-reflow tick outside standalone PWA mode", () => {
    const env = createEnv({ standalone: false });
    env.flushFrame();
    const offsetReadsBeforeInstall = env.document.documentElement.offsetHeightReads;
    const rectCallsBeforeInstall = env.document.body.getBoundingClientRectCalls;
    const computedBeforeInstall = env.getComputedStyleCalls;

    const cleanup = installMobileViewportMetrics(env);
    env.flushFrame();

    // Run every pending timer at most once — none of them should be the reflow tick,
    // which would call body.getBoundingClientRect + getComputedStyle on documentElement.
    const callbacks = [...env.timers.values()];
    env.timers.clear();
    for (const cb of callbacks) cb();

    expect(env.document.documentElement.offsetHeightReads).toBe(offsetReadsBeforeInstall);
    expect(env.document.body.getBoundingClientRectCalls).toBe(rectCallsBeforeInstall);
    expect(env.getComputedStyleCalls).toBe(computedBeforeInstall);

    cleanup();
  });

  it("is a no-op without browser document APIs", () => {
    const cleanup = installMobileViewportMetrics({});
    expect(typeof cleanup).toBe("function");
    expect(applyMobileViewportMetrics({})).toBe(null);
  });
});
