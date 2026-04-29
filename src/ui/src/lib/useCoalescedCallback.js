import { useCallback, useEffect, useRef } from "preact/hooks";

export function useCoalescedCallback(callback, delayMs = 100) {
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
