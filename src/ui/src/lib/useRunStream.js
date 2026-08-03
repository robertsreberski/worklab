// src/ui/src/lib/useRunStream.js
import { useEffect, useRef, useState } from "preact/hooks";
import { aggregateRunArtifacts, extractRunArtifacts } from "./runArtifacts.js";
import { closeSharedEventSourcesForTests, subscribeSharedEventSource } from "./sharedEventSource.js";
import { tailRunEventsByVisibleItems } from "../../../core/run-events.js";
import { createRunTodoState, runTodoStateSummary } from "../../../core/run-todos.js";
import { useAppResume } from "./pageVisibility.js";

const runStreams = new Map();
const DEFAULT_LIVE_EVENT_LIMIT = 10;
const DEFAULT_INITIAL_EVENT_LIMIT = DEFAULT_LIVE_EVENT_LIMIT;
const DEFAULT_MAX_EVENTS = DEFAULT_LIVE_EVENT_LIMIT;
// Upper bound on remembered tool_use events kept to pair with later tool_results.
// Each entry holds an event payload (often a few KB of JSON), so an unbounded map
// becomes the dominant heap retainer for long-running agent sessions. Pairing
// across more than this many intervening tool calls is unusual and degrades
// gracefully (the orphan tool_use stays in the events tail, just without its result).
export const TOOL_USE_MEMORY_LIMIT = 256;
// Cap for the "Load full history" path. Without this, a 50k-event run pulled in
// "full" mode pins the entire transcript in heap for every open subscriber.
export const FULL_HISTORY_MAX_EVENTS = 2000;
const TOOL_USE_EVENT_TYPES = new Set(["tool_use", "toolCall"]);
const TOOL_RESULT_EVENT_TYPES = new Set(["tool_result", "toolResult", "tool_output", "structured_output"]);

function eventKey(event) {
  if (!event) return null;
  if (event._worklab_display_key) return `display:${event._worklab_display_key}`;
  if (event._event_seq != null) return `seq:${event._event_seq}`;
  if (event.id != null) return `id:${event.id}`;
  try {
    return `json:${JSON.stringify(event)}`;
  } catch {
    return null;
  }
}

function eventPayload(event) {
  if (event?.type === "sdk_event" && event.event) return event.event;
  if (event?.type === "cli_event" && event.raw) return event.raw;
  return event;
}

function eventContentBlocks(event) {
  const target = eventPayload(event);
  if (Array.isArray(target?.message?.content)) return target.message.content;
  if (Array.isArray(target?.content)) return target.content;
  return [];
}

function toolUseIdsFromEvent(event) {
  const target = eventPayload(event);
  const ids = [];
  const add = (id) => { if (id) ids.push(id); };
  if (TOOL_USE_EVENT_TYPES.has(target?.type)) {
    add(target.tool_use_id || target.id || target.toolCallId || target.tool_call_id);
  }
  for (const block of eventContentBlocks(event)) {
    if (TOOL_USE_EVENT_TYPES.has(block?.type)) {
      add(block.tool_use_id || block.id || block.toolCallId || block.tool_call_id);
    }
  }
  return [...new Set(ids)];
}

function toolResultIdsFromEvent(event) {
  const target = eventPayload(event);
  const ids = [];
  const add = (id) => { if (id) ids.push(id); };
  if (TOOL_RESULT_EVENT_TYPES.has(target?.type)) {
    add(target.tool_use_id || target.id || target.toolCallId || target.tool_call_id);
  }
  for (const block of eventContentBlocks(event)) {
    if (TOOL_RESULT_EVENT_TYPES.has(block?.type)) {
      add(block.tool_use_id || block.id || block.toolCallId || block.tool_call_id);
    }
  }
  return [...new Set(ids)];
}

function toolUseBlocksFromEvent(event) {
  const target = eventPayload(event);
  const blocks = [];
  if (TOOL_USE_EVENT_TYPES.has(target?.type)) blocks.push(target);
  for (const block of eventContentBlocks(event)) {
    if (TOOL_USE_EVENT_TYPES.has(block?.type)) blocks.push(block);
  }
  return blocks;
}

function toolResultBlocksFromEvent(event) {
  const target = eventPayload(event);
  const blocks = [];
  if (TOOL_RESULT_EVENT_TYPES.has(target?.type)) blocks.push(target);
  for (const block of eventContentBlocks(event)) {
    if (TOOL_RESULT_EVENT_TYPES.has(block?.type)) blocks.push(block);
  }
  return blocks;
}

function normalizedToolName(name) {
  return String(name || "").split("__").filter(Boolean).at(-1) || "";
}

function isTodoWriteToolName(name) {
  return normalizedToolName(name) === "todo_write";
}

function parseJsonValue(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsedToolResultContent(block) {
  const candidates = [block?.content, block?.output, block?.result, block?.value];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const parsed = parseJsonValue(item?.text || item?.content);
        if (parsed) return parsed;
      }
      continue;
    }
    const parsed = parseJsonValue(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export function todoStateFromToolEvents(previousState, events = []) {
  // First pass: index every todo_write tool_use and any matching tool_result so we
  // can resolve rejected writes ({ok: false}) by ignoring their optimistic state
  // instead of leaving it stranded in the UI.
  const writes = [];
  const byId = new Map();
  for (const event of events || []) {
    for (const block of toolUseBlocksFromEvent(event)) {
      if (!isTodoWriteToolName(block?.name)) continue;
      const id = block.tool_use_id || block.id || block.toolCallId || block.tool_call_id;
      const todos = Array.isArray(block?.input?.todos) ? block.input.todos : null;
      const ts = Number(event?.ts) || Date.now();
      const entry = { id: id || null, todos, ts, result: null };
      if (id) byId.set(id, entry);
      writes.push(entry);
    }
    for (const block of toolResultBlocksFromEvent(event)) {
      const id = block.tool_use_id || block.id || block.toolCallId || block.tool_call_id;
      if (!id || !byId.has(id)) continue;
      const parsed = parsedToolResultContent(block);
      byId.get(id).result = { isError: block?.is_error === true, parsed };
    }
  }

  let latest = null;
  for (const entry of writes) {
    const result = entry.result;
    if (result?.parsed?.ok === true && result.parsed.todo_state) {
      latest = runTodoStateSummary(result.parsed.todo_state);
      continue;
    }
    if (result && (result.isError || result.parsed?.ok === false)) continue;
    if (entry.todos) {
      try {
        latest = runTodoStateSummary(createRunTodoState(entry.todos, {
          previousState: latest || previousState,
          now: entry.ts,
        }));
      } catch {
        // Invalid optimistic input; the server's tool_result will correct on arrival.
      }
    }
  }
  return latest || (previousState ? runTodoStateSummary(previousState) : null);
}

function rememberToolUses(entry, events = []) {
  if (!entry?.toolUsesById) return;
  for (const event of events || []) {
    for (const id of toolUseIdsFromEvent(event)) {
      // Re-insert so insertion order tracks recency for LRU eviction below.
      entry.toolUsesById.delete(id);
      entry.toolUsesById.set(id, event);
    }
  }
  while (entry.toolUsesById.size > TOOL_USE_MEMORY_LIMIT) {
    const oldest = entry.toolUsesById.keys().next().value;
    if (oldest === undefined) break;
    entry.toolUsesById.delete(oldest);
  }
}

function companionToolUseEvents(entry, event) {
  if (!entry?.toolUsesById) return [];
  const matches = [];
  for (const id of toolResultIdsFromEvent(event)) {
    const stored = entry.toolUsesById.get(id);
    if (!stored) continue;
    matches.push(stored);
    // Once paired with its result the tool_use no longer needs to be retained.
    entry.toolUsesById.delete(id);
  }
  return matches;
}

function containsEvent(events, target) {
  const targetKey = eventKey(target);
  if (!targetKey) return false;
  return (events || []).some((event) => eventKey(event) === targetKey);
}

function limitRunEvents(events, limit) {
  return tailRunEventsByVisibleItems(events, limit);
}

function eventOrder(event) {
  const firstDisplaySeq = Number(event?._worklab_first_event_seq);
  if (Number.isFinite(firstDisplaySeq)) return firstDisplaySeq;
  const eventSeq = Number(event?._event_seq);
  return Number.isFinite(eventSeq) ? eventSeq : null;
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
  merged.sort((a, b) => {
    const left = eventOrder(a);
    const right = eventOrder(b);
    if (left == null || right == null) return 0;
    return left - right;
  });
  return limitRunEvents(merged, limit);
}

function runStreamUrl(runId) {
  return `/api/runs/${encodeURIComponent(runId)}/stream`;
}

function ensureRunStream(runId) {
  let entry = runStreams.get(runId);
  if (entry) return entry;
  entry = {
    eventCallbacks: new Set(),
    stateCallbacks: new Set(),
    streamUnsubscribe: null,
    done: false,
    loading: false,
    run: null,
    events: [],
    liveArtifacts: [],
    eventCount: 0,
    eventsTruncated: false,
    fullHistoryLoaded: false,
    hasDisplayProjection: false,
    maxEvents: DEFAULT_MAX_EVENTS,
    toolUsesById: new Map(),
    streamRefCount: 0,
    hydratePromise: null,
    hydrateController: null,
    hydrateKey: null,
    forceHydrate: false,
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
  entry?.streamUnsubscribe?.();
  if (entry) entry.streamUnsubscribe = null;
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
    liveArtifacts: [...(entry?.liveArtifacts || [])],
    run: entry?.run || null,
    eventCount: Number(entry?.eventCount || entry?.events?.length || 0),
    eventsTruncated: Boolean(entry?.eventsTruncated),
    fullHistoryLoaded: Boolean(entry?.fullHistoryLoaded),
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
  const encodedRunId = encodeURIComponent(runId);
  if (initialEventLimit === null) return `/api/runs/${encodedRunId}`;
  const query = new URLSearchParams({
    events: "tail",
    limit: String(initialEventLimit ?? DEFAULT_INITIAL_EVENT_LIMIT),
  });
  return `/api/runs/${encodedRunId}?${query}`;
}

function hydrationKey(initialEventLimit) {
  return initialEventLimit === null ? "full" : `tail:${initialEventLimit ?? DEFAULT_INITIAL_EVENT_LIMIT}`;
}

function normalizeMaxEvents(maxEvents) {
  if (maxEvents === null) return null;
  const parsed = Number(maxEvents ?? DEFAULT_MAX_EVENTS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_EVENTS;
}

function expandEntryMaxEvents(entry, maxEvents) {
  const nextMax = normalizeMaxEvents(maxEvents);
  if (entry.maxEvents === null || nextMax === null) {
    entry.maxEvents = null;
    return;
  }
  entry.maxEvents = Math.max(entry.maxEvents || DEFAULT_MAX_EVENTS, nextMax);
}

function applyRunHydration(entry, data, maxEvents, { fullHistory = false } = {}) {
  if (data?.run) entry.run = data.run;
  const storedArtifacts = Array.isArray(data?.run?.artifacts) ? data.run.artifacts : [];
  const eventArtifacts = extractRunArtifacts(data?.log?.events || []);
  if (storedArtifacts.length || eventArtifacts.length) {
    entry.liveArtifacts = aggregateRunArtifacts([
      { id: entry.run?.id, started_at: entry.run?.started_at, artifacts: entry.liveArtifacts || [] },
      { id: entry.run?.id, started_at: entry.run?.started_at, artifacts: storedArtifacts },
      { id: entry.run?.id, started_at: entry.run?.started_at, artifacts: eventArtifacts },
    ]);
  }
  if (data?.log?.events?.length) {
    if (data.log.events.some((event) => event?._worklab_display_key)) {
      entry.hasDisplayProjection = true;
    }
    rememberToolUses(entry, data.log.events);
    entry.events = limitRunEvents(
      mergeRunEvents(entry.events, data.log.events),
      maxEvents,
    );
  }
  if (data?.log) {
    const hydratedCount = Number(data.log.event_count ?? entry.events.length);
    entry.eventCount = Math.max(Number(entry.eventCount || 0), hydratedCount, entry.events.length);
    entry.eventsTruncated = Boolean(data.log.events_truncated)
      || (entry.maxEvents !== null && entry.events.length < entry.eventCount);
  } else {
    entry.eventCount = Math.max(Number(entry.eventCount || 0), entry.events.length);
    entry.eventsTruncated = entry.maxEvents !== null && entry.events.length < entry.eventCount;
  }
  if (fullHistory) {
    const serverTruncated = Boolean(data?.log?.events_truncated)
      || data?.log?.payload_fidelity === "compacted";
    const locallyCapped = entry.maxEvents !== null && entry.events.length < entry.eventCount;
    const stillTruncated = serverTruncated || locallyCapped;
    entry.fullHistoryLoaded = !stillTruncated;
    entry.eventsTruncated = stillTruncated;
    entry.eventCount = Math.max(Number(entry.eventCount || 0), entry.events.length);
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
  expandEntryMaxEvents(entry, maxEvents);
  if (!entry.forceHydrate && entry.hydratePromise && entry.hydrateKey === nextKey) return entry.hydratePromise;
  if (!entry.forceHydrate && entry.hydrateKey === nextKey && entry.run) return Promise.resolve(runStateSnapshot(entry));
  entry.hydrateController?.abort?.();
  const controller = new AbortController();
  entry.hydrateController = controller;
  entry.hydrateKey = nextKey;
  entry.forceHydrate = false;
  entry.loading = true;
  notifyRunState(entry);
  const promise = fetch(runUrl(runId, initialEventLimit), { signal: controller.signal })
    .then((response) => response.ok ? response.json() : null)
    .then((data) => {
      if (controller.signal.aborted || !data) return null;
      const { status, liveInput } = applyRunHydration(entry, data, entry.maxEvents, {
        fullHistory: initialEventLimit === null,
      });
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
  if (entry.streamUnsubscribe || entry.done || typeof EventSource === "undefined") return;
  entry.streamUnsubscribe = subscribeSharedEventSource(`run:${runId}`, runStreamUrl(runId), (payload) => {
    for (const callback of [...entry.eventCallbacks]) callback(payload);
    if (payload?.type === "done") {
      entry.done = true;
      entry.loading = false;
      notifyRunState(entry);
      closeRunStream(runId, entry);
      return;
    }
    const previousCount = Number(entry.eventCount || entry.events.length || 0);
    if (payload?._worklab_display_key) entry.hasDisplayProjection = true;
    rememberToolUses(entry, [payload]);
    const companionEvents = companionToolUseEvents(entry, payload);
    const todoState = todoStateFromToolEvents(entry.run?.todo_state, [...companionEvents, payload]);
    if (todoState) {
      entry.run = {
        ...(entry.run || { id: runId }),
        todo_state: todoState,
      };
    }
    const mergedEvents = mergeRunEvents(entry.events, [...companionEvents, payload]);
    const eventArtifacts = extractRunArtifacts([payload]);
    if (eventArtifacts.length) {
      entry.liveArtifacts = aggregateRunArtifacts([
        { id: entry.run?.id || runId, started_at: entry.run?.started_at, artifacts: entry.liveArtifacts || [] },
        { id: entry.run?.id || runId, started_at: entry.run?.started_at, artifacts: eventArtifacts },
      ]);
    }
    const seq = Number(payload?._event_seq);
    const inferredCount = containsEvent(entry.events, payload) ? previousCount : previousCount + 1;
    entry.events = limitRunEvents(mergedEvents, entry.maxEvents);
    entry.eventCount = Math.max(
      previousCount,
      !entry.hasDisplayProjection && Number.isFinite(seq) ? seq : 0,
      inferredCount,
      entry.events.length,
    );
    entry.eventsTruncated = !entry.fullHistoryLoaded && entry.events.length < entry.eventCount;
    notifyRunState(entry);
  });
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
  expandEntryMaxEvents(entry, maxEvents);
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

export function loadFullRunHistory(runId, { subscribe = true } = {}) {
  if (!runId) return Promise.resolve(null);
  const entry = ensureRunStream(runId);
  return hydrateRunState(runId, entry, {
    initialEventLimit: null,
    maxEvents: FULL_HISTORY_MAX_EVENTS,
    subscribe,
  });
}

export function refreshRunState(runId, {
  subscribe = true,
  initialEventLimit,
  maxEvents,
} = {}) {
  if (!runId) return Promise.resolve(null);
  const entry = ensureRunStream(runId);
  const nextInitialEventLimit = initialEventLimit !== undefined
    ? initialEventLimit
    : (entry.fullHistoryLoaded ? null : DEFAULT_INITIAL_EVENT_LIMIT);
  const nextMaxEvents = maxEvents !== undefined
    ? maxEvents
    : entry.maxEvents;
  entry.forceHydrate = true;
  return hydrateRunState(runId, entry, {
    initialEventLimit: nextInitialEventLimit,
    maxEvents: nextMaxEvents,
    subscribe,
  });
}

export function closeRunStreamsForTests() {
  for (const [runId, entry] of runStreams.entries()) {
    entry.hydrateController?.abort?.();
    clearRunRefresh(entry);
    clearRunNotify(entry);
    closeRunStream(runId, entry);
  }
  runStreams.clear();
  closeSharedEventSourcesForTests();
}

export function getRunStreamStateForTests(runId) {
  return runStreams.get(runId) || null;
}

export function useRunStream(runId, {
  subscribe = true,
  initialEventLimit = DEFAULT_INITIAL_EVENT_LIMIT,
  maxEvents = DEFAULT_MAX_EVENTS,
} = {}) {
  const [events, setEvents] = useState([]);
  const [run, setRun] = useState(null);
  const [eventCount, setEventCount] = useState(0);
  const [eventsTruncated, setEventsTruncated] = useState(false);
  const [fullHistoryLoaded, setFullHistoryLoaded] = useState(false);
  const [liveArtifacts, setLiveArtifacts] = useState([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const unsubscribeRef = useRef(null);

  useEffect(() => {
    if (!runId) {
      setEvents([]);
      setRun(null);
      setEventCount(0);
      setEventsTruncated(false);
      setFullHistoryLoaded(false);
      setLiveArtifacts([]);
      setDone(false);
      setLoading(false);
      return;
    }
    setEvents([]);
    setRun(null);
    setEventCount(0);
    setEventsTruncated(false);
    setFullHistoryLoaded(false);
    setLiveArtifacts([]);
    setDone(false);
    setLoading(true);
    unsubscribeRef.current = subscribeRunState(runId, (snapshot) => {
      setEvents(snapshot.events);
      setRun(snapshot.run);
      setEventCount(snapshot.eventCount);
      setEventsTruncated(snapshot.eventsTruncated);
      setFullHistoryLoaded(snapshot.fullHistoryLoaded);
      setLiveArtifacts(snapshot.liveArtifacts || []);
      setDone(snapshot.done);
      setLoading(snapshot.loading);
    }, { subscribe, initialEventLimit, maxEvents });
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [runId, subscribe, initialEventLimit, maxEvents]);

  useAppResume(() => {
    if (!runId) return;
    refreshRunState(runId, {
      subscribe,
      initialEventLimit: fullHistoryLoaded ? null : initialEventLimit,
      maxEvents: fullHistoryLoaded ? FULL_HISTORY_MAX_EVENTS : maxEvents,
    });
  });

  const loadFullHistory = () => loadFullRunHistory(runId, { subscribe });

  return { events, run, eventCount, eventsTruncated, fullHistoryLoaded, liveArtifacts, done, loading, loadFullHistory };
}
