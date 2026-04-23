let counter = 0;
const subscribers = new Set();
let toasts = [];

function notify() {
  for (const fn of subscribers) fn(toasts);
}

export function pushToast(message, { variant = "info", ttl = 4000 } = {}) {
  const id = ++counter;
  toasts = [...toasts, { id, message, variant }];
  notify();
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
  return id;
}

export function dismissToast(id) {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

export function subscribeToasts(fn) {
  subscribers.add(fn);
  fn(toasts);
  return () => subscribers.delete(fn);
}
