const DEFAULT_HEARTBEAT_MS = 2_000;
const DEFAULT_LEASE_MS = 6_000;
const DEFAULT_ELECTION_DELAY_MS = 25;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 15_000;
const CHANNEL_PREFIX = "worklab.shared-stream.";
const LEASE_PREFIX = "worklab.sharedStreamLease.";

function randomTabId() {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function envTimer(env, name) {
  return (...args) => {
    const fn = env?.[name] || globalThis[name];
    return typeof fn === "function" ? fn(...args) : undefined;
  };
}

function pageVisibility(env) {
  return env?.document?.visibilityState === "hidden" ? "hidden" : "visible";
}

function isClosedEventSource(source, EventSourceCtor) {
  const closed = EventSourceCtor?.CLOSED ?? source?.CLOSED ?? 2;
  return source?.readyState === closed;
}

export function createSharedEventSourceRuntime({
  tabId = randomTabId(),
  env = globalThis,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  leaseMs = DEFAULT_LEASE_MS,
  electionDelayMs = DEFAULT_ELECTION_DELAY_MS,
  reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
  reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
} = {}) {
  const entries = new Map();
  const setTimeoutFn = envTimer(env, "setTimeout");
  const clearTimeoutFn = envTimer(env, "clearTimeout");
  const setIntervalFn = envTimer(env, "setInterval");
  const clearIntervalFn = envTimer(env, "clearInterval");

  function now() {
    return Date.now();
  }

  function canShare() {
    return typeof env?.BroadcastChannel === "function"
      && typeof env?.EventSource === "function"
      && env?.localStorage;
  }

  function leaseKey(key) {
    return `${LEASE_PREFIX}${key}`;
  }

  function readLease(entry) {
    return safeJsonParse(safeCall(() => env.localStorage.getItem(leaseKey(entry.key)), null));
  }

  function writeLease(entry) {
    const lease = {
      ownerId: tabId,
      expiresAt: now() + leaseMs,
      visibility: pageVisibility(env),
      updatedAt: now(),
    };
    safeCall(() => env.localStorage.setItem(leaseKey(entry.key), JSON.stringify(lease)));
    return lease;
  }

  function removeOwnLease(entry) {
    const lease = readLease(entry);
    if (!lease || lease.ownerId === tabId) {
      safeCall(() => env.localStorage.removeItem(leaseKey(entry.key)));
    }
  }

  function leaseIsValid(lease) {
    return Boolean(lease?.ownerId && Number(lease.expiresAt) > now());
  }

  function shouldAcquire(entry) {
    if (entry.callbacks.size === 0) return false;
    if (pageVisibility(env) === "hidden") return false;
    const lease = readLease(entry);
    if (!leaseIsValid(lease)) return true;
    if (lease.ownerId === tabId) return true;
    return lease.visibility === "hidden";
  }

  function post(entry, payload) {
    entry.channel?.postMessage?.({
      ...payload,
      key: entry.key,
      tabId,
    });
  }

  function emitLocal(entry, payload) {
    for (const callback of [...entry.callbacks]) callback(payload);
  }

  function clearTimer(entry, name, clearer = clearTimeoutFn) {
    if (!entry?.[name]) return;
    clearer?.(entry[name]);
    entry[name] = null;
  }

  function clearOwnerTimers(entry) {
    clearTimer(entry, "heartbeatTimer", clearIntervalFn);
    clearTimer(entry, "reconnectTimer", clearTimeoutFn);
  }

  function clearEntryTimers(entry) {
    clearOwnerTimers(entry);
    clearTimer(entry, "electionTimer", clearTimeoutFn);
    clearTimer(entry, "leaseCheckTimer", clearIntervalFn);
  }

  function closeSource(entry) {
    entry.source?.close?.();
    entry.source = null;
  }

  function scheduleOwnerReconnect(entry) {
    if (!entry.isOwner || entry.reconnectTimer || entry.callbacks.size === 0) return;
    entry.reconnectAttempts += 1;
    const delay = Math.min(reconnectBaseMs * 2 ** (entry.reconnectAttempts - 1), reconnectMaxMs);
    entry.reconnectTimer = setTimeoutFn?.(() => {
      entry.reconnectTimer = null;
      openOwnedSource(entry);
    }, delay);
  }

  function openOwnedSource(entry) {
    if (entry.source || entry.callbacks.size === 0 || typeof env?.EventSource !== "function") return;
    const source = new env.EventSource(entry.url);
    source.onopen = () => {
      entry.reconnectAttempts = 0;
      if (entry.key !== "sse:global") return;
      const payload = {
        type: "worklab_stream_connected",
        streamKey: entry.key,
      };
      emitLocal(entry, payload);
      if (entry.shared) post(entry, { type: "event", payload });
    };
    source.onmessage = (event) => {
      const payload = safeJsonParse(event.data);
      if (!payload) return;
      emitLocal(entry, payload);
      if (entry.shared) post(entry, { type: "event", payload });
    };
    source.onerror = () => {
      if (!isClosedEventSource(source, env.EventSource)) return;
      closeSource(entry);
      scheduleOwnerReconnect(entry);
    };
    entry.source = source;
  }

  function becomeOwner(entry) {
    if (entry.callbacks.size === 0) return;
    entry.isOwner = true;
    const lease = writeLease(entry);
    post(entry, { type: "heartbeat", ownerId: tabId, lease });
    clearTimer(entry, "heartbeatTimer", clearIntervalFn);
    entry.heartbeatTimer = setIntervalFn?.(() => {
      if (!entry.isOwner || entry.callbacks.size === 0) return;
      const nextLease = writeLease(entry);
      post(entry, { type: "heartbeat", ownerId: tabId, lease: nextLease });
    }, heartbeatMs);
    openOwnedSource(entry);
  }

  function releaseOwner(entry, { broadcast = true, removeLease = true } = {}) {
    if (!entry.isOwner && !entry.source) return;
    entry.isOwner = false;
    clearOwnerTimers(entry);
    closeSource(entry);
    if (removeLease) removeOwnLease(entry);
    if (broadcast && entry.shared) post(entry, { type: "release", ownerId: tabId });
  }

  function acquire(entry) {
    if (!entry.shared) {
      entry.isOwner = true;
      openOwnedSource(entry);
      return;
    }
    if (!shouldAcquire(entry)) return;
    if (entry.isOwner) {
      writeLease(entry);
      return;
    }
    const lease = writeLease(entry);
    const confirmed = readLease(entry);
    if (confirmed?.ownerId !== tabId) return;
    post(entry, { type: "claim", ownerId: tabId, lease });
    becomeOwner(entry);
  }

  function electSoon(entry, delay = electionDelayMs) {
    if (entry.electionTimer || entry.callbacks.size === 0) return;
    entry.electionTimer = setTimeoutFn?.(() => {
      entry.electionTimer = null;
      acquire(entry);
    }, delay);
  }

  function handleChannelMessage(entry, message) {
    if (!message || message.key !== entry.key || message.tabId === tabId) return;
    if (message.type === "event") {
      emitLocal(entry, message.payload);
      return;
    }
    if (message.type === "release") {
      electSoon(entry);
      return;
    }
    if (message.type === "claim" || message.type === "heartbeat") {
      const lease = readLease(entry);
      if (entry.isOwner && lease?.ownerId && lease.ownerId !== tabId) {
        releaseOwner(entry, { broadcast: false, removeLease: false });
      }
    }
  }

  function handleVisibilityChange(entry) {
    if (pageVisibility(env) === "hidden") {
      if (entry.isOwner) releaseOwner(entry);
      return;
    }
    electSoon(entry, 0);
  }

  function ensureEntry(key, url) {
    let entry = entries.get(key);
    if (entry) {
      entry.url = url;
      return entry;
    }
    entry = {
      key,
      url,
      callbacks: new Set(),
      shared: canShare(),
      channel: null,
      source: null,
      isOwner: false,
      heartbeatTimer: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      electionTimer: null,
      leaseCheckTimer: null,
      visibilityListener: null,
    };
    if (entry.shared) {
      entry.channel = new env.BroadcastChannel(`${CHANNEL_PREFIX}${key}`);
      entry.channel.onmessage = (event) => handleChannelMessage(entry, event.data);
    }
    entries.set(key, entry);
    return entry;
  }

  function startEntry(entry) {
    if (entry.callbacks.size !== 1) return;
    if (entry.shared) {
      entry.leaseCheckTimer = setIntervalFn?.(() => electSoon(entry), heartbeatMs);
      entry.visibilityListener = () => handleVisibilityChange(entry);
      env.document?.addEventListener?.("visibilitychange", entry.visibilityListener);
      acquire(entry);
      return;
    }
    acquire(entry);
  }

  function stopEntry(entry) {
    releaseOwner(entry);
    clearEntryTimers(entry);
    if (entry.visibilityListener) {
      env.document?.removeEventListener?.("visibilitychange", entry.visibilityListener);
      entry.visibilityListener = null;
    }
    entry.channel?.close?.();
    entries.delete(entry.key);
  }

  function subscribe(key, url, onEvent) {
    if (!key || !url || typeof onEvent !== "function") return () => {};
    const entry = ensureEntry(String(key), url);
    entry.callbacks.add(onEvent);
    startEntry(entry);
    return () => {
      entry.callbacks.delete(onEvent);
      if (entry.callbacks.size === 0) stopEntry(entry);
    };
  }

  function closeAll() {
    for (const entry of [...entries.values()]) {
      entry.callbacks.clear();
      stopEntry(entry);
    }
  }

  return {
    subscribe,
    closeAll,
    _entries: entries,
  };
}

const defaultRuntime = createSharedEventSourceRuntime();

export function subscribeSharedEventSource(key, url, onEvent) {
  return defaultRuntime.subscribe(key, url, onEvent);
}

export function closeSharedEventSourcesForTests() {
  defaultRuntime.closeAll();
}
