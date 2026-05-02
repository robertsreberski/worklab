import { useEffect, useRef } from "preact/hooks";

const DEFAULT_RESUME_DEDUPE_MS = 750;

export function pageIsVisible(env = globalThis) {
  return env?.document?.visibilityState !== "hidden";
}

export function onPageVisible(callback, env = globalThis) {
  if (typeof callback !== "function" || !env?.document?.addEventListener) return () => {};
  const listener = () => {
    if (pageIsVisible(env)) callback();
  };
  env.document.addEventListener("visibilitychange", listener);
  return () => env.document.removeEventListener?.("visibilitychange", listener);
}

function windowTarget(env) {
  if (env?.window?.addEventListener) return env.window;
  return env;
}

export function subscribeAppResume(callback, env = globalThis, options = {}) {
  if (typeof callback !== "function") return () => {};
  const target = windowTarget(env);
  const document = env?.document;
  if (!document?.addEventListener && !target?.addEventListener) return () => {};

  const dedupeMs = Number.isFinite(Number(options.dedupeMs))
    ? Number(options.dedupeMs)
    : DEFAULT_RESUME_DEDUPE_MS;
  let backgrounded = document?.visibilityState === "hidden";
  let lastResumeAt = 0;

  const emitResume = (reason, event) => {
    if (!pageIsVisible(env)) return;
    if (!backgrounded && reason !== "pageshow") return;
    const timestamp = Date.now();
    if (lastResumeAt && timestamp - lastResumeAt < dedupeMs) {
      backgrounded = false;
      return;
    }
    backgrounded = false;
    lastResumeAt = timestamp;
    callback({ reason, event });
  };

  const onVisibilityChange = (event) => {
    if (!pageIsVisible(env)) {
      backgrounded = true;
      return;
    }
    emitResume("visibilitychange", event);
  };
  const onPageShow = (event) => {
    if (event?.persisted) emitResume("pageshow", event);
  };
  const onFocus = (event) => emitResume("focus", event);

  document?.addEventListener?.("visibilitychange", onVisibilityChange);
  target?.addEventListener?.("pageshow", onPageShow);
  target?.addEventListener?.("focus", onFocus);

  return () => {
    document?.removeEventListener?.("visibilitychange", onVisibilityChange);
    target?.removeEventListener?.("pageshow", onPageShow);
    target?.removeEventListener?.("focus", onFocus);
  };
}

export function useAppResume(callback, env = globalThis, options = {}) {
  const callbackRef = useRef(callback);
  const dedupeMs = options?.dedupeMs;
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    return subscribeAppResume((event) => callbackRef.current?.(event), env, { dedupeMs });
  }, [dedupeMs, env]);
}
