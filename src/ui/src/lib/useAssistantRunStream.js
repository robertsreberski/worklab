import { useEffect, useState } from "preact/hooks";
import { api } from "./api.js";
import { useAppResume } from "./pageVisibility.js";
import { closeSSEForTests, subscribeSSE } from "./useSSE.js";
import { mergeRunEvents } from "./useRunStream.js";

const assistantRunStreams = new Map();
const DEFAULT_INITIAL_EVENT_LIMIT = 100;
const DEFAULT_POLL_MS = 2_000;

function runStatus(run) {
  return run?.status || "running";
}

function isTerminalRun(run) {
  const status = runStatus(run);
  return Boolean(status && status !== "running");
}

function ensureAssistantRunStream(runId) {
  let entry = assistantRunStreams.get(runId);
  if (entry) return entry;
  entry = {
    stateCallbacks: new Set(),
    run: null,
    events: [],
    eventCount: 0,
    eventsTruncated: false,
    done: false,
    donePayload: null,
    loading: false,
    streamUnsubscribe: null,
    subscribeCount: 0,
    hydrateController: null,
    hydratePromise: null,
    pollTimer: null,
    pollMs: DEFAULT_POLL_MS,
    initialEventLimit: DEFAULT_INITIAL_EVENT_LIMIT,
  };
  assistantRunStreams.set(runId, entry);
  return entry;
}

function clearAssistantPoll(entry) {
  if (!entry?.pollTimer) return;
  clearTimeout(entry.pollTimer);
  entry.pollTimer = null;
}

function closeAssistantGlobalStream(entry) {
  entry?.streamUnsubscribe?.();
  if (entry) entry.streamUnsubscribe = null;
}

function assistantRunSnapshot(entry) {
  return {
    events: [...(entry?.events || [])],
    run: entry?.run || null,
    eventCount: Number(entry?.eventCount || entry?.events?.length || 0),
    eventsTruncated: Boolean(entry?.eventsTruncated),
    done: Boolean(entry?.done),
    donePayload: entry?.donePayload || null,
    loading: Boolean(entry?.loading),
  };
}

function notifyAssistantRunState(entry) {
  const snapshot = assistantRunSnapshot(entry);
  for (const callback of [...entry.stateCallbacks]) callback(snapshot);
}

function applyAssistantHydration(entry, data) {
  if (data?.run) entry.run = data.run;
  const events = Array.isArray(data?.run?.events) ? data.run.events : [];
  if (events.length) {
    entry.events = mergeRunEvents(entry.events, events, { limit: entry.initialEventLimit });
  }
  const hydratedCount = Number(data?.run?.event_count ?? entry.events.length);
  entry.eventCount = Math.max(Number(entry.eventCount || 0), hydratedCount, entry.events.length);
  entry.eventsTruncated = Boolean(data?.run?.events_truncated) || entry.events.length < entry.eventCount;
  if (isTerminalRun(data?.run)) {
    entry.done = true;
    clearAssistantPoll(entry);
    closeAssistantGlobalStream(entry);
  }
}

function scheduleAssistantRefresh(runId, entry, options = {}) {
  clearAssistantPoll(entry);
  const pollMs = Number(options.pollMs ?? entry.pollMs ?? DEFAULT_POLL_MS);
  if (!Number.isFinite(pollMs) || pollMs <= 0 || entry.done || entry.subscribeCount === 0) return;
  entry.pollTimer = setTimeout(() => {
    entry.pollTimer = null;
    refreshAssistantRunState(runId, {
      subscribe: entry.subscribeCount > 0,
      initialEventLimit: entry.initialEventLimit,
      pollMs,
    });
  }, pollMs);
  entry.pollTimer.unref?.();
}

function hydrateAssistantRunState(runId, entry, {
  subscribe = true,
  initialEventLimit = DEFAULT_INITIAL_EVENT_LIMIT,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  entry.hydrateController?.abort?.();
  const controller = new AbortController();
  entry.hydrateController = controller;
  entry.initialEventLimit = initialEventLimit;
  entry.pollMs = pollMs;
  entry.loading = true;
  notifyAssistantRunState(entry);
  const promise = api.getAssistantRun(
    runId,
    { events: "tail", limit: String(initialEventLimit) },
    { signal: controller.signal },
  ).then((data) => {
    if (controller.signal.aborted) return null;
    applyAssistantHydration(entry, data);
    return assistantRunSnapshot(entry);
  }).catch(() => null).finally(() => {
    if (!controller.signal.aborted) {
      entry.loading = false;
      notifyAssistantRunState(entry);
      if (subscribe && !entry.done) scheduleAssistantRefresh(runId, entry, { pollMs });
    }
    if (entry.hydrateController === controller) entry.hydrateController = null;
    if (entry.hydratePromise === promise) entry.hydratePromise = null;
  });
  entry.hydratePromise = promise;
  return promise;
}

function openAssistantGlobalStream(runId, entry) {
  if (entry.streamUnsubscribe || entry.done || entry.subscribeCount === 0) return;
  entry.streamUnsubscribe = subscribeSSE("global", (payload) => {
    if (!payload || payload.run_id !== runId) return;
    if (payload.type === "assistant_run_event" && payload.event) {
      entry.events = mergeRunEvents(entry.events, [payload.event], { limit: entry.initialEventLimit });
      const seq = Number(payload.event_seq ?? payload.event?._event_seq);
      entry.eventCount = Math.max(
        Number(entry.eventCount || 0),
        Number.isFinite(seq) ? seq + 1 : 0,
        entry.events.length,
      );
      entry.eventsTruncated = entry.events.length < entry.eventCount;
      notifyAssistantRunState(entry);
      return;
    }
    if (payload.type === "assistant_run_ended") {
      if (payload.run) entry.run = payload.run;
      entry.done = true;
      entry.donePayload = payload;
      entry.loading = false;
      clearAssistantPoll(entry);
      closeAssistantGlobalStream(entry);
      notifyAssistantRunState(entry);
    }
  });
}

function cleanupAssistantRunStream(runId, entry) {
  if (!entry || entry.stateCallbacks.size > 0) return;
  entry.hydrateController?.abort?.();
  clearAssistantPoll(entry);
  closeAssistantGlobalStream(entry);
  assistantRunStreams.delete(runId);
}

export function subscribeAssistantRunState(runId, onSnapshot, options = {}) {
  if (!runId || typeof onSnapshot !== "function") return () => {};
  const {
    subscribe = true,
    initialEventLimit = DEFAULT_INITIAL_EVENT_LIMIT,
    pollMs = DEFAULT_POLL_MS,
  } = options;
  const entry = ensureAssistantRunStream(runId);
  entry.stateCallbacks.add(onSnapshot);
  if (subscribe) entry.subscribeCount += 1;
  onSnapshot(assistantRunSnapshot(entry));
  if (subscribe) openAssistantGlobalStream(runId, entry);
  hydrateAssistantRunState(runId, entry, { subscribe, initialEventLimit, pollMs });
  return () => {
    entry.stateCallbacks.delete(onSnapshot);
    if (subscribe) entry.subscribeCount = Math.max(0, entry.subscribeCount - 1);
    if (entry.subscribeCount === 0) {
      clearAssistantPoll(entry);
      closeAssistantGlobalStream(entry);
    }
    cleanupAssistantRunStream(runId, entry);
  };
}

export function refreshAssistantRunState(runId, options = {}) {
  if (!runId) return Promise.resolve(null);
  const entry = ensureAssistantRunStream(runId);
  if (options.subscribe !== false) openAssistantGlobalStream(runId, entry);
  return hydrateAssistantRunState(runId, entry, {
    subscribe: options.subscribe !== false,
    initialEventLimit: options.initialEventLimit ?? entry.initialEventLimit ?? DEFAULT_INITIAL_EVENT_LIMIT,
    pollMs: options.pollMs ?? entry.pollMs ?? DEFAULT_POLL_MS,
  });
}

export function closeAssistantRunStreamsForTests() {
  for (const [runId, entry] of assistantRunStreams.entries()) {
    entry.stateCallbacks.clear();
    entry.hydrateController?.abort?.();
    clearAssistantPoll(entry);
    closeAssistantGlobalStream(entry);
    assistantRunStreams.delete(runId);
  }
  closeSSEForTests();
}

export function useAssistantRunStream(runId, {
  subscribe = true,
  hydrate = true,
  initialEventLimit = DEFAULT_INITIAL_EVENT_LIMIT,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  const [events, setEvents] = useState([]);
  const [run, setRun] = useState(null);
  const [done, setDone] = useState(false);
  const [donePayload, setDonePayload] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!runId || !hydrate) {
      setEvents([]);
      setRun(null);
      setDone(false);
      setDonePayload(null);
      setLoading(false);
      return undefined;
    }
    return subscribeAssistantRunState(runId, (snapshot) => {
      setEvents(snapshot.events);
      setRun(snapshot.run);
      setDone(snapshot.done);
      setDonePayload(snapshot.donePayload);
      setLoading(snapshot.loading);
    }, { subscribe, initialEventLimit, pollMs });
  }, [runId, subscribe, hydrate, initialEventLimit, pollMs]);

  useAppResume(() => {
    if (!runId || !hydrate) return;
    refreshAssistantRunState(runId, { subscribe, initialEventLimit, pollMs });
  });

  return { events, run, done, donePayload, loading };
}
