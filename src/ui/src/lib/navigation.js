import { useCallback, useEffect, useState } from "preact/hooks";

let activeGuard = null;
const allowedHashes = new Set();

export function normalizeHash(hash) {
  if (!hash) return "#/tasks";
  if (hash.startsWith("#")) return hash;
  if (hash.startsWith("/")) return `#${hash}`;
  return `#/${hash.replace(/^#?\/?/, "")}`;
}

export function registerNavigationGuard(guard) {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

export function getNavigationGuard() {
  return activeGuard;
}

export function allowHashNavigationOnce(hash) {
  allowedHashes.add(normalizeHash(hash));
}

export function consumeAllowedHash(hash) {
  const normalized = normalizeHash(hash);
  if (!allowedHashes.has(normalized)) return false;
  allowedHashes.delete(normalized);
  return true;
}

export function proceedToHash(hash) {
  const target = normalizeHash(hash);
  allowHashNavigationOnce(target);
  if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

export function navigateHash(hash) {
  const target = normalizeHash(hash);
  const guard = getNavigationGuard();
  if (guard?.isDirty?.()) {
    guard.requestPrompt?.(target);
    return false;
  }
  proceedToHash(target);
  return true;
}

export function useUnsavedChangesGuard({ isDirty, onSave }) {
  const [pendingHash, setPendingHash] = useState(null);

  useEffect(() => {
    if (!isDirty) {
      setPendingHash(null);
    }
  }, [isDirty]);

  useEffect(() => {
    const unregister = registerNavigationGuard({
      isDirty: () => !!isDirty,
      requestPrompt: (hash) => setPendingHash((current) => current || normalizeHash(hash)),
    });
    return unregister;
  }, [isDirty]);

  useEffect(() => {
    function onBeforeUnload(event) {
      if (!isDirty) return;
      event.preventDefault();
      event.returnValue = "";
      return "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  const requestNavigation = useCallback((hash) => navigateHash(hash), []);
  const keepEditing = useCallback(() => setPendingHash(null), []);
  const discardAndLeave = useCallback(() => {
    const target = pendingHash;
    setPendingHash(null);
    if (target) proceedToHash(target);
  }, [pendingHash]);
  const saveAndLeave = useCallback(async () => {
    const target = pendingHash;
    if (!target) return;
    await onSave?.();
    setPendingHash(null);
    proceedToHash(target);
  }, [onSave, pendingHash]);

  return {
    pendingHash,
    promptOpen: !!pendingHash,
    requestNavigation,
    keepEditing,
    discardAndLeave,
    saveAndLeave,
  };
}
