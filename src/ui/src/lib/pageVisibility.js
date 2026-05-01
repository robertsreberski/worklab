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
