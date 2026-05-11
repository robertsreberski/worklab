import { useCallback, useEffect, useRef, useState } from "preact/hooks";

let activeGuard = null;
const allowedHashes = new Set();
const LEGACY_ROUTE_ALIASES = {
  activity: ["runs"],
  agents: ["library", "agents"],
  knowledge: ["library", "knowledge"],
  providers: ["settings", "providers"],
  skills: ["library", "skills"],
  teams: ["library", "teams"],
};

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isAppRouteHash(hash) {
  if (!hash) return true;
  const value = String(hash);
  if (value === "#") return true;
  if (value.startsWith("#/")) return true;
  if (!value.startsWith("#")) return true;
  return false;
}

export function normalizeHash(hash) {
  if (!hash) return "#/tasks";
  const value = String(hash);
  let normalized;
  if (value.startsWith("#")) normalized = value;
  else if (value.startsWith("/")) normalized = `#${value}`;
  else normalized = `#/${value.replace(/^#?\/?/, "")}`;
  if (!normalized.startsWith("#/")) return normalized;

  const raw = normalized.replace(/^#\/?/, "");
  const queryIndex = raw.indexOf("?");
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const queryString = queryIndex === -1 ? "" : raw.slice(queryIndex);
  const segments = pathPart.replace(/^\/+/, "").split("/").filter(Boolean);
  const alias = LEGACY_ROUTE_ALIASES[segments[0]];
  if (!alias) return normalized;
  return `#/${[...alias, ...segments.slice(1)].join("/")}${queryString}`;
}

export function parseHashRoute(hash = "") {
  const normalized = isAppRouteHash(hash) ? normalizeHash(hash) : "#/tasks";
  const raw = normalized.replace(/^#\/?/, "");
  const queryIndex = raw.indexOf("?");
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const queryString = queryIndex === -1 ? "" : raw.slice(queryIndex + 1);
  const path = pathPart.replace(/^\/+/, "") || "tasks";
  const segments = path.split("/").filter(Boolean).map(safeDecode);
  const query = {};
  for (const [key, value] of new URLSearchParams(queryString)) {
    query[key] = value;
  }
  return {
    route: segments[0] || "tasks",
    rest: segments.slice(1),
    path,
    queryString,
    query,
  };
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
  const isDirtyRef = useRef(!!isDirty);
  isDirtyRef.current = !!isDirty;

  useEffect(() => {
    if (!isDirty) {
      setPendingHash(null);
    }
  }, [isDirty]);

  useEffect(() => {
    const unregister = registerNavigationGuard({
      isDirty: () => !!isDirtyRef.current,
      requestPrompt: (hash) => setPendingHash((current) => current || normalizeHash(hash)),
    });
    return unregister;
  }, []);

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

  const requestNavigation = useCallback((hash) => {
    const target = normalizeHash(hash);
    if (isDirtyRef.current) {
      setPendingHash((current) => current || target);
      return false;
    }
    proceedToHash(target);
    return true;
  }, []);
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
