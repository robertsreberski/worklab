// src/ui/src/lib/useRunStream.js
import { useEffect, useRef, useState } from "preact/hooks";

const runStreams = new Map();

function eventKey(event) {
  if (!event) return null;
  if (event._event_seq != null) return `seq:${event._event_seq}`;
  if (event.id != null) return `id:${event.id}`;
  try {
    return `json:${JSON.stringify(event)}`;
  } catch {
    return null;
  }
}

function limitRunEvents(events, limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1 || events.length <= parsed) return events;
  return events.slice(-parsed);
}

export function mergeRunEvents(current = [], incoming = [], { limit = null } = {}) {
  const merged = [];
  const positions = new Map();
  for (const event of [...(current || []), ...(incoming || [])]) {
    if (!event) continue;
    const key = eventKey(event);
    if (key && positions.has(key)) {
      merged[positions.get(key)] = event;
      continue;
    }
    if (key) positions.set(key, merged.length);
    merged.push(event);
  }
  return merged.sort((a, b) => {
    if (a?._event_seq == null || b?._event_seq == null) return 0;
    return Number(a._event_seq) - Number(b._event_seq);
  }).slice(limit ? -limit : undefined);
}

function runStreamUrl(runId) {
  return `/api/runs/${runId}/stream`;
}

function ensureRunStream(runId) {
  let entry = runStreams.get(runId);
  if (entry) return entry;
  entry = { callbacks: new Set(), source: null, done: false };
  runStreams.set(runId, entry);
  return entry;
}

function closeRunStream(runId, entry) {
  entry?.source?.close?.();
  if (entry) entry.source = null;
  if (!entry || entry.callbacks.size === 0) runStreams.delete(runId);
}

function openRunStream(runId, entry) {
  if (entry.source || entry.done || typeof EventSource === "undefined") return;
  const source = new EventSource(runStreamUrl(runId));
  source.onmessage = (e) => {
    let payload;
    try {
      payload = JSON.parse(e.data);
    } catch {
      return;
    }
    for (const callback of [...entry.callbacks]) callback(payload);
    if (payload?.type === "done") {
      entry.done = true;
      closeRunStream(runId, entry);
    }
  };
  source.onerror = () => {
    closeRunStream(runId, entry);
  };
  entry.source = source;
}

export function subscribeRunStream(runId, onEvent) {
  if (!runId || typeof onEvent !== "function") return () => {};
  const entry = ensureRunStream(runId);
  entry.callbacks.add(onEvent);
  openRunStream(runId, entry);
  return () => {
    entry.callbacks.delete(onEvent);
    if (entry.callbacks.size === 0) closeRunStream(runId, entry);
  };
}

export function closeRunStreamsForTests() {
  for (const [runId, entry] of runStreams.entries()) {
    closeRunStream(runId, entry);
  }
  runStreams.clear();
}

export function useRunStream(runId, { subscribe = true, initialEventLimit = 200, maxEvents = 200 } = {}) {
  const [events, setEvents] = useState([]);
  const [run, setRun] = useState(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const unsubscribeRef = useRef(null);

  useEffect(() => {
    if (!runId) {
      setEvents([]);
      setRun(null);
      setDone(false);
      setLoading(false);
      return;
    }
    setEvents([]); setRun(null); setDone(false); setLoading(true);
    const controller = new AbortController();
    let cancelled = false;
    let runRefreshTimer = null;
    function clearRunRefresh() {
      if (runRefreshTimer) clearTimeout(runRefreshTimer);
      runRefreshTimer = null;
    }
    function runUrl() {
      if (initialEventLimit === null) return `/api/runs/${runId}`;
      const query = new URLSearchParams({ events: "tail", limit: String(initialEventLimit) });
      return `/api/runs/${runId}?${query}`;
    }
    function mergeIncoming(prev, incoming) {
      return limitRunEvents(mergeRunEvents(prev, incoming), maxEvents);
    }

    function hydrateRun() {
      clearRunRefresh();
      // Preload any already-recorded events (run may have ended before we connected)
      return fetch(runUrl(), { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(data => {
        if (cancelled) return;
        if (data?.run) setRun(data.run);
        if (data?.log?.events?.length) setEvents((prev) => mergeIncoming(prev, data.log.events));
        const status = data?.run?.process_status || data?.run?.status;
        if (status && status !== "running") setDone(true);
        const liveInput = data?.run?.live_input;
        if (subscribe && status === "running" && liveInput?.supported && !liveInput.active) {
          runRefreshTimer = setTimeout(hydrateRun, 1000);
        }
      }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    }
    hydrateRun();
    if (!subscribe) return () => { cancelled = true; controller.abort(); };
    unsubscribeRef.current = subscribeRunStream(runId, (payload) => {
      if (payload.type === "done") {
        setDone(true);
        return;
      }
      setEvents((prev) => mergeIncoming(prev, [payload]));
    });
    return () => {
      cancelled = true;
      clearRunRefresh();
      controller.abort();
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [runId, subscribe, initialEventLimit, maxEvents]);

  return { events, run, done, loading };
}
