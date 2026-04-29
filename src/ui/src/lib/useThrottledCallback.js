import { useCallback, useEffect, useRef } from "preact/hooks";

/**
 * Returns a stable callback that fires at most once per `delayMs` window.
 *
 * Semantics:
 * - First call schedules `callback` to run after `delayMs`.
 * - Calls during the open window are dropped (no trailing fire).
 * - The next post-window call starts a new window.
 *
 * Suitable for idempotent reloads where each invocation re-fetches the
 * latest state. Do NOT use for handlers that consume per-event payloads —
 * dropped calls take their payloads with them.
 */
export function useThrottledCallback(callback, delayMs = 100) {
  const callbackRef = useRef(callback);
  const timerRef = useRef(null);

  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      callbackRef.current?.();
    }, delayMs);
  }, [delayMs]);
}
