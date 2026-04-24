// §5.5 useLiveTicker — cycles an event list at intervalMs (default 2200).
// When a new event arrives, the ticker advances to it immediately — the row
// always prefers showing the freshest activity over finishing the cycle.
import { useEffect, useRef, useState } from "preact/hooks";

export function useLiveTicker(events, { intervalMs = 2200, running = true } = {}) {
  const [idx, setIdx] = useState(0);
  const prevLenRef = useRef(0);

  useEffect(() => {
    const len = events?.length || 0;
    if (len > prevLenRef.current) {
      // new event arrived — snap to the newest immediately
      setIdx(len - 1);
    }
    prevLenRef.current = len;
  }, [events]);

  useEffect(() => {
    if (!running || !events || events.length === 0) return undefined;
    const timer = setInterval(() => setIdx((i) => (i + 1) % events.length), intervalMs);
    return () => clearInterval(timer);
  }, [events, intervalMs, running]);

  if (!events || events.length === 0) return null;
  return events[idx % events.length];
}
