// Toast queue — §4.9 API. TTL 2500 default, errors 4500. Max 3 visible.
// Hover pauses (implemented in ToastHost).

let counter = 0;
const subscribers = new Set();
let toasts = [];

function notify() {
  for (const fn of subscribers) fn(toasts);
}

const VARIANT_TTL = { success: 2500, info: 2500, error: 4500 };
const MAX_VISIBLE = 3;

export function pushToast(message, { variant = "info", ttl } = {}) {
  const id = ++counter;
  const resolvedTtl = ttl ?? VARIANT_TTL[variant] ?? 2500;
  const entry = { id, message, variant, ttl: resolvedTtl, pausedAt: null, remaining: resolvedTtl, timer: null };
  toasts = [...toasts, entry].slice(-MAX_VISIBLE - 5); // keep a small tail; host clips to MAX_VISIBLE
  notify();
  if (resolvedTtl > 0) {
    entry.timer = setTimeout(() => dismissToast(id), resolvedTtl);
  }
  return id;
}

export function dismissToast(id) {
  const t = toasts.find((x) => x.id === id);
  if (t?.timer) clearTimeout(t.timer);
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

export function pauseToast(id) {
  const t = toasts.find((x) => x.id === id);
  if (!t || t.pausedAt || !t.timer) return;
  clearTimeout(t.timer);
  t.timer = null;
  t.pausedAt = Date.now();
}

export function resumeToast(id) {
  const t = toasts.find((x) => x.id === id);
  if (!t || !t.pausedAt) return;
  const elapsed = t.pausedAt - (t.startedAt || t.pausedAt - 0);
  t.remaining = Math.max(500, t.remaining - elapsed);
  t.pausedAt = null;
  t.timer = setTimeout(() => dismissToast(id), t.remaining);
}

export function subscribeToasts(fn) {
  subscribers.add(fn);
  fn(toasts);
  return () => subscribers.delete(fn);
}

// Convenience helpers per toast policy (§5.11).
export const toast = {
  success: (message, opts) => pushToast(message, { ...opts, variant: "success" }),
  error:   (message, opts) => pushToast(message, { ...opts, variant: "error" }),
  info:    (message, opts) => pushToast(message, { ...opts, variant: "info" }),
};
