import { useState, useCallback, useRef } from "preact/hooks";

export function useFormSave(performSave) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const inFlightRef = useRef(null);
  const save = useCallback(async (...args) => {
    if (inFlightRef.current) return inFlightRef.current;
    setSaving(true);
    setError(null);
    const promise = Promise.resolve().then(() => performSave(...args)).catch((err) => {
      const message = err?.message || String(err);
      setError(message);
      throw err;
    }).finally(() => {
      if (inFlightRef.current === promise) {
        inFlightRef.current = null;
        setSaving(false);
      }
    });
    inFlightRef.current = promise;
    return promise;
  }, [performSave]);
  const clearError = useCallback(() => setError(null), []);
  return { saving, error, save, clearError };
}
