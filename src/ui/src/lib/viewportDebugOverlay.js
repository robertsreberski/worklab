// Diagnostic overlay for the iOS PWA empty-band bug. Activate by appending
// `?debug-viewport=1` to the PWA URL once, then re-open the app from the home
// screen — the param sticks via localStorage so the PWA shows it on every launch
// until cleared with `?debug-viewport=0`.
//
// The overlay paints a fixed translucent strip at the top of the viewport with
// live numeric values for every dimension that could possibly explain a body /
// dock height mismatch on iOS. Read them off the device and report — no
// guessing required.
//
// NOTE: this overlay's side-effect (1 Hz forced layout + computed-style reads)
// is what originally fixed the iOS 26.2+ empty-band bug. That fix has since been
// productionized — see forceViewportReflow / the viewport-reflow tick in
// `./mobileViewport.js`. This file remains purely opt-in diagnostics.

const ENABLE_KEY = "worklab.debugViewport";

function readEnableFlag() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("debug-viewport")) {
      const value = params.get("debug-viewport");
      if (value === "0" || value === "false") {
        window.localStorage?.removeItem?.(ENABLE_KEY);
        return false;
      }
      window.localStorage?.setItem?.(ENABLE_KEY, "1");
      return true;
    }
    return window.localStorage?.getItem?.(ENABLE_KEY) === "1";
  } catch {
    return false;
  }
}

function fmt(value) {
  if (value == null) return "—";
  if (typeof value === "number") return Math.round(value);
  return String(value);
}

function snapshot() {
  const win = window;
  const doc = document;
  const root = doc.documentElement;
  const body = doc.body;
  const rootStyles = win.getComputedStyle?.(root);
  const bodyStyles = body ? win.getComputedStyle(body) : null;
  const dock = doc.querySelector(".assistant-dock");
  const composer = doc.querySelector(".assistant-composer");
  const textarea = composer?.querySelector(".textarea");
  const tabbar = doc.querySelector(".app-tabbar");
  const dockStyles = dock ? win.getComputedStyle(dock) : null;
  const composerStyles = composer ? win.getComputedStyle(composer) : null;
  const dockRect = dock?.getBoundingClientRect();
  const composerRect = composer?.getBoundingClientRect();
  const textareaRect = textarea?.getBoundingClientRect();
  const bodyRect = body?.getBoundingClientRect();
  const tabbarRect = tabbar?.getBoundingClientRect();
  const visibleBottom = (win.visualViewport?.height || win.innerHeight) + (win.visualViewport?.offsetTop || 0);
  return {
    innerH: win.innerHeight,
    screenH: win.screen?.height,
    clientH: root.clientHeight,
    bodyH: body?.offsetHeight,
    bodyRectH: bodyRect?.height,
    bodyRectBot: bodyRect?.bottom,
    vvH: win.visualViewport?.height,
    vvOffT: win.visualViewport?.offsetTop,
    vvScale: win.visualViewport?.scale,
    rootShell: rootStyles?.getPropertyValue("--shell-height").trim(),
    rootApp: rootStyles?.getPropertyValue("--app-height").trim(),
    rootVv: rootStyles?.getPropertyValue("--vv-height").trim(),
    rootKeyboard: rootStyles?.getPropertyValue("--worklab-keyboard-height").trim(),
    assistantLift: dockStyles?.getPropertyValue("--assistant-keyboard-lift").trim(),
    assistantLiftMode: dock?.dataset?.assistantKeyboardMode || "none",
    assistantFocused: dock?.classList.contains("assistant-composer-focused") ? "Y" : "n",
    rootSat: rootStyles?.getPropertyValue("--worklab-safe-area-top").trim(),
    rootSab: rootStyles?.getPropertyValue("--worklab-safe-area-bottom").trim(),
    bodyComputedH: bodyStyles?.height,
    bodyOverflow: bodyStyles?.overflowY,
    keyboardOpen: root.classList.contains("keyboard-open") ? "Y" : "n",
    standalone: win.matchMedia?.("(display-mode: standalone)")?.matches ? "Y" : "n",
    iosStd: win.navigator?.standalone ? "Y" : "n",
    dockH: dockRect?.height,
    dockBot: dockRect?.bottom,
    composerTop: composerRect?.top,
    composerH: composerRect?.height,
    composerBot: composerRect?.bottom,
    composerTransform: composerStyles?.transform,
    textareaBot: textareaRect?.bottom,
    visibleBottom,
    composerOverlap: composerRect?.bottom == null ? null : Math.max(0, composerRect.bottom - visibleBottom),
    tabbarBot: tabbarRect?.bottom,
    pixelRatio: win.devicePixelRatio,
    orientation: win.screen?.orientation?.type || "?",
  };
}

function renderRows(snap) {
  const rows = [
    ["window", `inner=${fmt(snap.innerH)}  client=${fmt(snap.clientH)}  screen=${fmt(snap.screenH)}`],
    ["body  ", `off=${fmt(snap.bodyH)}  rect=${fmt(snap.bodyRectH)}  bot=${fmt(snap.bodyRectBot)}  ovY=${fmt(snap.bodyOverflow)}`],
    ["body H", `computed=${fmt(snap.bodyComputedH)}`],
    ["vview ", `h=${fmt(snap.vvH)}  offT=${fmt(snap.vvOffT)}  scale=${fmt(snap.vvScale)}`],
    ["css   ", `--shell=${fmt(snap.rootShell)}  --app=${fmt(snap.rootApp)}  --vv=${fmt(snap.rootVv)}`],
    ["safe  ", `--sat=${fmt(snap.rootSat)}  --sab=${fmt(snap.rootSab)}`],
    ["keybd ", `root=${fmt(snap.rootKeyboard)}  lift=${fmt(snap.assistantLift)}`],
    ["mode  ", `assistant=${fmt(snap.assistantLiftMode)}  focused=${snap.assistantFocused}  visible.bot=${fmt(snap.visibleBottom)}  overlap=${fmt(snap.composerOverlap)}`],
    ["dock  ", `h=${fmt(snap.dockH)}  bot=${fmt(snap.dockBot)}  tabbar.bot=${fmt(snap.tabbarBot)}`],
    ["comp  ", `top=${fmt(snap.composerTop)}  h=${fmt(snap.composerH)}  bot=${fmt(snap.composerBot)}  input.bot=${fmt(snap.textareaBot)}`],
    ["trans ", `composer=${fmt(snap.composerTransform)}`],
    ["state ", `kb=${snap.keyboardOpen}  standalone=${snap.standalone}/${snap.iosStd}  dpr=${fmt(snap.pixelRatio)}  orient=${snap.orientation}`],
  ];
  return rows.map(([label, value]) => `${label}  ${value}`).join("\n");
}

function inject(root) {
  const overlay = document.createElement("pre");
  overlay.id = "wl-debug-viewport";
  overlay.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "right: 0",
    "z-index: 99999",
    "margin: 0",
    "padding: 6px 8px",
    "font: 9px/1.25 ui-monospace, Menlo, monospace",
    "color: #69dcc6",
    "background: rgba(0, 0, 0, 0.82)",
    "white-space: pre",
    "pointer-events: none",
    "max-width: 100vw",
    "overflow: hidden",
    "text-shadow: 0 0 1px black",
  ].join(";");
  document.body.appendChild(overlay);

  const refresh = () => {
    overlay.textContent = renderRows(snapshot());
  };

  refresh();
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      refresh();
    });
  };

  for (const evt of ["resize", "orientationchange", "pageshow"]) {
    window.addEventListener(evt, schedule, { passive: true });
  }
  document.addEventListener("visibilitychange", schedule, { passive: true });
  document.addEventListener("focusin", schedule, true);
  document.addEventListener("focusout", schedule, true);
  document.addEventListener("touchstart", schedule, { passive: true });
  document.addEventListener("touchend", schedule, { passive: true });
  window.visualViewport?.addEventListener?.("resize", schedule, { passive: true });
  window.visualViewport?.addEventListener?.("scroll", schedule, { passive: true });
  // Belt-and-suspenders: refresh once a second so the user sees changes even if
  // no event fires (the iOS bug we're chasing skips events).
  setInterval(refresh, 1000);
}

export function installViewportDebugOverlay() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (!readEnableFlag()) return;
  if (document.body) {
    inject(document);
  } else {
    document.addEventListener("DOMContentLoaded", () => inject(document), { once: true });
  }
}
