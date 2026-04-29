import { useEffect, useRef } from "preact/hooks";

const streams = new Map();

function streamUrl(channel) {
  return channel === "global" ? "/api/events/stream" : `/api/events/${encodeURIComponent(channel)}/stream`;
}

function ensureStream(channel) {
  let entry = streams.get(channel);
  if (entry) return entry;
  entry = { callbacks: new Set(), source: null };
  streams.set(channel, entry);
  return entry;
}

function openStream(channel, entry) {
  if (entry.source || typeof EventSource === "undefined") return;
  const source = new EventSource(streamUrl(channel));
  source.onmessage = (e) => {
    let payload;
    try {
      payload = JSON.parse(e.data);
    } catch {
      return;
    }
    for (const callback of [...entry.callbacks]) callback(payload);
  };
  entry.source = source;
}

export function subscribeSSE(channel, onEvent) {
  const entry = ensureStream(channel);
  entry.callbacks.add(onEvent);
  openStream(channel, entry);
  return () => {
    entry.callbacks.delete(onEvent);
    if (entry.callbacks.size > 0) return;
    entry.source?.close?.();
    streams.delete(channel);
  };
}

export function closeSSEForTests() {
  for (const entry of streams.values()) entry.source?.close?.();
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
