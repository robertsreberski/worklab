import { useEffect, useState } from "preact/hooks";

export function useLiveTicker(events, { intervalMs = 1800, running = true } = {}) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!running || !events || events.length === 0) return undefined;
    const timer = setInterval(() => setIdx((i) => (i + 1) % events.length), intervalMs);
    return () => clearInterval(timer);
  }, [events, intervalMs, running]);

  if (!events || events.length === 0) return null;
  return events[idx % events.length];
}
