import { useCallback, useEffect, useRef, useState } from "preact/hooks";

const activeGuards = [];
let activeOverlayNavigationHandler = null;
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
  activeGuards.push(guard);
  return () => {
    const index = activeGuards.indexOf(guard);
    if (index !== -1) activeGuards.splice(index, 1);
  };
}

export function getNavigationGuard() {
  return activeGuards[activeGuards.length - 1] || null;
}

export function registerOverlayNavigationHandler(handler) {
  activeOverlayNavigationHandler = handler;
  return () => {
    if (activeOverlayNavigationHandler === handler) activeOverlayNavigationHandler = null;
  };
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

export function proceedToHash(hash, options = {}) {
  const target = normalizeHash(hash);
  if (!options.bypassOverlay && routeWithinOverlay(target)) return true;
  allowHashNavigationOnce(target);
  if (window.location.hash !== target) {
    window.location.hash = target;
  }
  return true;
}

function routeWithinOverlay(target) {
  return !!activeOverlayNavigationHandler?.(target);
}

function proceedToHashOrOverlay(hash) {
  const target = normalizeHash(hash);
  if (routeWithinOverlay(target)) return true;
  return proceedToHash(target);
}

export function requestGuardedAction(action) {
  const guard = getNavigationGuard();
  if (guard?.isDirty?.()) {
    guard.requestPrompt?.(null, action);
    return false;
  }
  action?.();
  return true;
}

export function navigateHash(hash, options = {}) {
  const target = normalizeHash(hash);
  const guard = getNavigationGuard();
  if (guard?.isDirty?.()) {
    guard.requestPrompt?.(target);
    return false;
  }
  if (!options.bypassOverlay && routeWithinOverlay(target)) return true;
  return proceedToHash(target, { bypassOverlay: options.bypassOverlay });
}

export function useUnsavedChangesGuard({ isDirty, onSave }) {
  const [pendingRequest, setPendingRequest] = useState(null);
  const isDirtyRef = useRef(!!isDirty);
  isDirtyRef.current = !!isDirty;
  const pendingHash = pendingRequest?.hash || null;

  useEffect(() => {
    if (!isDirty) {
      setPendingRequest(null);
    }
  }, [isDirty]);

  useEffect(() => {
    const unregister = registerNavigationGuard({
      isDirty: () => !!isDirtyRef.current,
      requestPrompt: (hash, action = null) => setPendingRequest((current) => current || {
        hash: hash ? normalizeHash(hash) : null,
        action,
      }),
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
      setPendingRequest((current) => current || { hash: target, action: null });
      return false;
    }
    proceedToHashOrOverlay(target);
    return true;
  }, []);
  const keepEditing = useCallback(() => setPendingRequest(null), []);
  const discardAndLeave = useCallback(() => {
    const request = pendingRequest;
    setPendingRequest(null);
    if (request?.action) request.action();
    else if (request?.hash) proceedToHashOrOverlay(request.hash);
  }, [pendingRequest]);
  const saveAndLeave = useCallback(async () => {
    const request = pendingRequest;
    if (!request) return;
    await onSave?.();
    setPendingRequest(null);
    if (request.action) request.action();
    else if (request.hash) proceedToHashOrOverlay(request.hash);
  }, [onSave, pendingRequest]);

  return {
    pendingHash,
    promptOpen: !!pendingRequest,
    requestNavigation,
    keepEditing,
    discardAndLeave,
    saveAndLeave,
  };
}
