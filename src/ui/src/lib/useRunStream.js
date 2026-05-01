// src/ui/src/lib/useRunStream.js
import { useEffect, useRef, useState } from "preact/hooks";

const runStreams = new Map();
const DEFAULT_INITIAL_EVENT_LIMIT = 24;
const DEFAULT_MAX_EVENTS = 80;

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
  entry = {
    eventCallbacks: new Set(),
    stateCallbacks: new Set(),
    source: null,
    done: false,
    loading: false,
    run: null,
    events: [],
    maxEvents: DEFAULT_MAX_EVENTS,
    streamRefCount: 0,
    hydratePromise: null,
    hydrateController: null,
    hydrateKey: null,
    refreshTimer: null,
    notifyTimer: null,
  };
  runStreams.set(runId, entry);
  return entry;
}

function clearRunRefresh(entry) {
  if (entry?.refreshTimer) clearTimeout(entry.refreshTimer);
  if (entry) entry.refreshTimer = null;
}

function clearRunNotify(entry) {
  if (!entry?.notifyTimer) return;
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(entry.notifyTimer);
  else clearTimeout(entry.notifyTimer);
  entry.notifyTimer = null;
}

function closeRunStream(runId, entry) {
  entry?.source?.close?.();
  if (entry) entry.source = null;
  if (!entry || (entry.eventCallbacks.size === 0 && entry.stateCallbacks.size === 0)) {
    entry?.hydrateController?.abort?.();
    clearRunRefresh(entry);
    clearRunNotify(entry);
    runStreams.delete(runId);
  }
}

function runStateSnapshot(entry) {
  return {
    events: [...(entry?.events || [])],
    run: entry?.run || null,
    done: Boolean(entry?.done),
    loading: Boolean(entry?.loading),
  };
}

function notifyRunState(entry) {
  if (!entry || entry.notifyTimer || entry.stateCallbacks.size === 0) return;
  const flush = () => {
    entry.notifyTimer = null;
    const snapshot = runStateSnapshot(entry);
    for (const callback of [...entry.stateCallbacks]) callback(snapshot);
  };
  entry.notifyTimer = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(flush)
    : setTimeout(flush, 0);
}

function runUrl(runId, initialEventLimit) {
  if (initialEventLimit === null) return `/api/runs/${runId}`;
  const query = new URLSearchParams({
    events: "tail",
    limit: String(initialEventLimit ?? DEFAULT_INITIAL_EVENT_LIMIT),
  });
  return `/api/runs/${runId}?${query}`;
}

function hydrationKey(initialEventLimit) {
  return initialEventLimit === null ? "full" : `tail:${initialEventLimit ?? DEFAULT_INITIAL_EVENT_LIMIT}`;
}

function applyRunHydration(entry, data, maxEvents) {
  if (data?.run) entry.run = data.run;
  if (data?.log?.events?.length) {
    entry.events = limitRunEvents(
      mergeRunEvents(entry.events, data.log.events),
      maxEvents,
    );
  }
  const status = data?.run?.process_status || data?.run?.status;
  if (status && status !== "running") entry.done = true;
  return { status, liveInput: data?.run?.live_input };
}

function hydrateRunState(runId, entry, {
  initialEventLimit = DEFAULT_INITIAL_EVENT_LIMIT,
  maxEvents = DEFAULT_MAX_EVENTS,
  subscribe = true,
} = {}) {
  const nextKey = hydrationKey(initialEventLimit);
  entry.maxEvents = Math.max(entry.maxEvents || DEFAULT_MAX_EVENTS, maxEvents || DEFAULT_MAX_EVENTS);
  if (entry.hydratePromise && entry.hydrateKey === nextKey) return entry.hydratePromise;
  if (entry.hydrateKey === nextKey && entry.run) return Promise.resolve(runStateSnapshot(entry));
  entry.hydrateController?.abort?.();
  const controller = new AbortController();
  entry.hydrateController = controller;
  entry.hydrateKey = nextKey;
  entry.loading = true;
  notifyRunState(entry);
  const promise = fetch(runUrl(runId, initialEventLimit), { signal: controller.signal })
    .then((response) => response.ok ? response.json() : null)
    .then((data) => {
      if (controller.signal.aborted || !data) return null;
      const { status, liveInput } = applyRunHydration(entry, data, entry.maxEvents);
      clearRunRefresh(entry);
      if (subscribe && status === "running" && liveInput?.supported && !liveInput.active) {
        entry.refreshTimer = setTimeout(() => {
          entry.hydrateKey = null;
          hydrateRunState(runId, entry, { initialEventLimit, maxEvents, subscribe });
        }, 1000);
      }
      return runStateSnapshot(entry);
    })
    .catch(() => null)
    .finally(() => {
      if (!controller.signal.aborted) {
        entry.loading = false;
        notifyRunState(entry);
      }
      if (entry.hydrateController === controller) entry.hydrateController = null;
      if (entry.hydratePromise === promise) entry.hydratePromise = null;
    });
  entry.hydratePromise = promise;
  return entry.hydratePromise;
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
    for (const callback of [...entry.eventCallbacks]) callback(payload);
    if (payload?.type === "done") {
      entry.done = true;
      entry.loading = false;
      notifyRunState(entry);
      closeRunStream(runId, entry);
      return;
    }
    entry.events = limitRunEvents(mergeRunEvents(entry.events, [payload]), entry.maxEvents || DEFAULT_MAX_EVENTS);
    notifyRunState(entry);
  };
  source.onerror = () => {
    closeRunStream(runId, entry);
  };
  entry.source = source;
}

export function subscribeRunStream(runId, onEvent) {
  if (!runId || typeof onEvent !== "function") return () => {};
  const entry = ensureRunStream(runId);
  entry.eventCallbacks.add(onEvent);
  entry.streamRefCount += 1;
  openRunStream(runId, entry);
  return () => {
    entry.eventCallbacks.delete(onEvent);
    entry.streamRefCount = Math.max(0, entry.streamRefCount - 1);
    if (entry.streamRefCount === 0) closeRunStream(runId, entry);
  };
}

export function subscribeRunState(runId, onSnapshot, options = {}) {
  if (!runId || typeof onSnapshot !== "function") return () => {};
  const entry = ensureRunStream(runId);
  const {
    subscribe = true,
    initialEventLimit = DEFAULT_INITIAL_EVENT_LIMIT,
    maxEvents = DEFAULT_MAX_EVENTS,
  } = options;
  entry.maxEvents = Math.max(entry.maxEvents || DEFAULT_MAX_EVENTS, maxEvents || DEFAULT_MAX_EVENTS);
  entry.stateCallbacks.add(onSnapshot);
  if (subscribe) {
    entry.streamRefCount += 1;
    openRunStream(runId, entry);
  }
  onSnapshot(runStateSnapshot(entry));
  hydrateRunState(runId, entry, { initialEventLimit, maxEvents, subscribe });
  return () => {
    entry.stateCallbacks.delete(onSnapshot);
    if (subscribe) entry.streamRefCount = Math.max(0, entry.streamRefCount - 1);
    if (entry.stateCallbacks.size === 0 && entry.eventCallbacks.size === 0) {
      closeRunStream(runId, entry);
      return;
    }
    if (entry.streamRefCount === 0) closeRunStream(runId, entry);
  };
}

export function closeRunStreamsForTests() {
  for (const [runId, entry] of runStreams.entries()) {
    entry.hydrateController?.abort?.();
    clearRunRefresh(entry);
    clearRunNotify(entry);
    closeRunStream(runId, entry);
  }
  runStreams.clear();
}

export function useRunStream(runId, {
  subscribe = true,
  initialEventLimit = DEFAULT_INITIAL_EVENT_LIMIT,
  maxEvents = DEFAULT_MAX_EVENTS,
} = {}) {
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
    setEvents([]);
    setRun(null);
    setDone(false);
    setLoading(true);
    unsubscribeRef.current = subscribeRunState(runId, (snapshot) => {
      setEvents(snapshot.events);
      setRun(snapshot.run);
      setDone(snapshot.done);
      setLoading(snapshot.loading);
    }, { subscribe, initialEventLimit, maxEvents });
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [runId, subscribe, initialEventLimit, maxEvents]);

  return { events, run, done, loading };
}
