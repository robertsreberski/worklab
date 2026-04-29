import { useEffect, useRef } from "preact/hooks";

const streams = new Map();
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15000;
let visibilityListenerInstalled = false;

function streamUrl(channel) {
  return channel === "global" ? "/api/events/stream" : `/api/events/${encodeURIComponent(channel)}/stream`;
}

function ensureStream(channel) {
  let entry = streams.get(channel);
  if (entry) return entry;
  entry = { callbacks: new Set(), source: null, reconnectTimer: null, reconnectAttempts: 0 };
  streams.set(channel, entry);
  return entry;
}

function clearReconnect(entry) {
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
}

function scheduleReconnect(channel, entry) {
  if (entry.reconnectTimer || entry.callbacks.size === 0) return;
  entry.reconnectAttempts += 1;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (entry.reconnectAttempts - 1), RECONNECT_MAX_MS);
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    openStream(channel, entry);
  }, delay);
}

function ensureVisibilityListener() {
  if (visibilityListenerInstalled || typeof document === "undefined") return;
  visibilityListenerInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const [channel, entry] of streams.entries()) {
      if (!entry.source && entry.callbacks.size > 0) {
        clearReconnect(entry);
        openStream(channel, entry);
      }
    }
  });
}

function openStream(channel, entry) {
  if (entry.source || typeof EventSource === "undefined") return;
  const source = new EventSource(streamUrl(channel));
  source.onopen = () => {
    entry.reconnectAttempts = 0;
  };
  source.onmessage = (e) => {
    let payload;
    try {
      payload = JSON.parse(e.data);
    } catch {
      return;
    }
    for (const callback of [...entry.callbacks]) callback(payload);
  };
  source.onerror = () => {
    if (source.readyState === source.CLOSED) {
      entry.source = null;
      scheduleReconnect(channel, entry);
    }
  };
  entry.source = source;
  ensureVisibilityListener();
}

export function subscribeSSE(channel, onEvent) {
  const entry = ensureStream(channel);
  entry.callbacks.add(onEvent);
  openStream(channel, entry);
  return () => {
    entry.callbacks.delete(onEvent);
    if (entry.callbacks.size > 0) return;
    clearReconnect(entry);
    entry.source?.close?.();
    streams.delete(channel);
  };
}

export function closeSSEForTests() {
  for (const entry of streams.values()) {
    clearReconnect(entry);
    entry.source?.close?.();
  }
  streams.clear();
}

export function useSSE(channel, onEvent) {
  const cbRef = useRef(onEvent);
  useEffect(() => {
    cbRef.current = onEvent;
  });

  useEffect(() => {
    return subscribeSSE(channel, (payload) => cbRef.current(payload));
  }, [channel]);
}
