// Observer registry + streaming telemetry.
//
// The runtime supports multiple observers per call. An observer is anything
// with a `recordEvent(event)` (and optionally `recordMetric(metric)` and
// `flush()`) method. Observers register at runtime construction time via
// `host.observers`, or per-call via `options.observers`. The existing
// `options.onEvent` callback is still respected — internally it becomes a
// thin observer so the rest of the kernel can keep emitting events through
// one channel.
//
// A built-in `createMetricsObserver()` aggregates cumulative cost, cache
// hit rate, token totals, tool-call counts, error counts, and turn-latency
// percentiles. Hosts that want their own aggregation implement the same
// interface and register alongside (or instead of) the built-in one.
//
// All observers receive events synchronously on the hot path; if an
// observer needs to do I/O it must buffer internally (zeroclaw uses the
// same contract — fan-out is sync, batching is the observer's problem).

/**
 * @typedef Observer
 * @property {string=} name
 * @property {(event: object) => void} recordEvent
 * @property {(metric: object) => void=} recordMetric
 * @property {() => (void | Promise<void>)=} flush
 */

export function createObserverHub({ observers = [], onEvent = null } = {}) {
  const list = [];
  for (const observer of observers || []) addObserver(list, observer);
  if (typeof onEvent === "function") {
    list.push({
      name: "host.onEvent",
      recordEvent: (event) => { try { onEvent(event); } catch { /* host emit errors don't escape */ } },
    });
  }

  function emit(event) {
    if (!event) return;
    for (const obs of list) {
      try { obs.recordEvent(event); } catch { /* swallow */ }
    }
  }

  function recordMetric(metric) {
    if (!metric) return;
    for (const obs of list) {
      if (typeof obs.recordMetric === "function") {
        try { obs.recordMetric(metric); } catch { /* swallow */ }
      }
    }
  }

  async function flush() {
    for (const obs of list) {
      if (typeof obs.flush === "function") {
        try { await obs.flush(); } catch { /* swallow */ }
      }
    }
  }

  return {
    emit,
    recordMetric,
    flush,
    observers: () => list.slice(),
  };
}

function addObserver(list, observer) {
  if (!observer || typeof observer.recordEvent !== "function") return;
  list.push(observer);
}

// Built-in aggregator. Pure in-memory; never throws.
//
// Snapshot shape:
// {
//   events: { total, byType: { "tool_use": 12, ... } },
//   tokens: { input, output, cacheReadTokens, cacheCreationTokens },
//   cost: { cumulativeUsd },
//   cache: { hits, misses, hitRatio },          // hitRatio in [0,1]; null if no signal
//   tools: { callsByName: { ... }, errorsByName: { ... } },
//   errors: { total, byKind: { ... } },
//   turns: { count, latencyMsP50, latencyMsP95 },
//   approvals: { pending, granted, denied },
// }
export function createMetricsObserver({ name = "metrics" } = {}) {
  const state = {
    eventsTotal: 0,
    eventsByType: new Map(),
    tokens: { input: 0, output: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    cumulativeCostUsd: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheReadTokensFromEvents: 0,
    toolCallsByName: new Map(),
    toolErrorsByName: new Map(),
    errorTotal: 0,
    errorsByKind: new Map(),
    turnLatencies: [],
    turnStartByModel: new Map(),
    approvalPending: 0,
    approvalGranted: 0,
    approvalDenied: 0,
  };

  function tally(map, key, by = 1) {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + by);
  }

  function recordEvent(event) {
    if (!event || typeof event !== "object") return;
    state.eventsTotal += 1;
    const type = String(event.type || "unknown");
    tally(state.eventsByType, type, 1);

    if (type === "tool_use" || (type === "assistant" && Array.isArray(event.message?.content))) {
      // Walk assistant content blocks for tool_use entries.
      const blocks = type === "tool_use" ? [event] : (event.message?.content || []);
      for (const block of blocks) {
        if (block && block.type === "tool_use" && block.name) tally(state.toolCallsByName, block.name, 1);
      }
    }

    if (type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block && block.type === "tool_result" && block.is_error) {
          // tool_use_id alone doesn't carry the tool name; bridges set
          // event.toolName when known. Fallback to "unknown".
          tally(state.toolErrorsByName, event.toolName || "unknown", 1);
        }
      }
    }

    if (type === "runtime_warning" && event.warning_kind) {
      // warnings are not errors but worth counting in `errorsByKind` only
      // when they indicate a failure mode.
    }

    if (type === "error" || type === "cancelled") {
      state.errorTotal += 1;
      tally(state.errorsByKind, event.failureKind || event.reason || type, 1);
    }

    if (type === "cache_hit") {
      state.cacheHits += 1;
      if (Number.isFinite(Number(event.tokens))) state.cacheReadTokensFromEvents += Number(event.tokens);
    }
    if (type === "cache_miss") {
      state.cacheMisses += 1;
    }

    if (type === "cost_accumulated") {
      // bridges send the running total, not the delta, so use it as the
      // current value rather than adding.
      if (Number.isFinite(Number(event.cumulativeUsd))) {
        state.cumulativeCostUsd = Number(event.cumulativeUsd);
      }
      if (event.tokens && typeof event.tokens === "object") {
        if (Number.isFinite(Number(event.tokens.input))) state.tokens.input = Number(event.tokens.input);
        if (Number.isFinite(Number(event.tokens.output))) state.tokens.output = Number(event.tokens.output);
        if (Number.isFinite(Number(event.tokens.cacheReadTokens))) state.tokens.cacheReadTokens = Number(event.tokens.cacheReadTokens);
        if (Number.isFinite(Number(event.tokens.cacheCreationTokens))) state.tokens.cacheCreationTokens = Number(event.tokens.cacheCreationTokens);
      }
    }

    if (type === "provider_request_started" && event.model) {
      state.turnStartByModel.set(event.model, (Number.isFinite(event.timestamp) ? event.timestamp : Date.now()));
    }
    if (type === "provider_request_completed" && event.model) {
      const started = state.turnStartByModel.get(event.model);
      if (started !== undefined) {
        state.turnLatencies.push(Math.max(0, ((Number.isFinite(event.timestamp) ? event.timestamp : Date.now())) - started));
        state.turnStartByModel.delete(event.model);
      }
    }
    if (type === "turn_latency" && Number.isFinite(Number(event.durationMs))) {
      state.turnLatencies.push(Number(event.durationMs));
    }

    if (type === "tool_approval_pending") state.approvalPending += 1;
    if (type === "tool_approval_granted") state.approvalGranted += 1;
    if (type === "tool_approval_denied") state.approvalDenied += 1;
  }

  function recordMetric() { /* future hook */ }

  function snapshot() {
    const cacheTotal = state.cacheHits + state.cacheMisses;
    const hitRatio = cacheTotal > 0 ? state.cacheHits / cacheTotal : null;
    return {
      events: { total: state.eventsTotal, byType: Object.fromEntries(state.eventsByType) },
      tokens: { ...state.tokens },
      cost: { cumulativeUsd: state.cumulativeCostUsd },
      cache: {
        hits: state.cacheHits,
        misses: state.cacheMisses,
        hitRatio,
        readTokensFromEvents: state.cacheReadTokensFromEvents,
      },
      tools: {
        callsByName: Object.fromEntries(state.toolCallsByName),
        errorsByName: Object.fromEntries(state.toolErrorsByName),
      },
      errors: { total: state.errorTotal, byKind: Object.fromEntries(state.errorsByKind) },
      turns: percentilesFor(state.turnLatencies),
      approvals: { pending: state.approvalPending, granted: state.approvalGranted, denied: state.approvalDenied },
    };
  }

  return { name, recordEvent, recordMetric, snapshot };
}

function percentilesFor(samples) {
  const arr = Array.isArray(samples) ? samples.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b) : [];
  if (!arr.length) return { count: 0, latencyMsP50: null, latencyMsP95: null };
  return {
    count: arr.length,
    latencyMsP50: percentile(arr, 0.5),
    latencyMsP95: percentile(arr, 0.95),
  };
}

function percentile(sortedArr, q) {
  if (!sortedArr.length) return null;
  const rank = q * (sortedArr.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (rank - lo);
}
