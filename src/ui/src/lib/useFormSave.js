import { useState, useCallback } from "preact/hooks";

export function useFormSave(performSave) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const save = useCallback(async (...args) => {
    setSaving(true);
    setError(null);
    try {
      return await performSave(...args);
    } catch (err) {
      const message = err?.message || String(err);
      setError(message);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [performSave]);
  const clearError = useCallback(() => setError(null), []);
  return { saving, error, save, clearError };
}
