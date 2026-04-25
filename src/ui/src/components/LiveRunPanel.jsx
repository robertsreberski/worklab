// §5.5 LiveRunPanel — cinematic per-event reveal for the currently streaming run.
// Uses the AgentEventTimeline internally (preserves heavy rendering) but adds a
// ShimmerBar at the top while the run is streaming and tracks incoming events so
// that the newest row animates in via wl-tick-in.

import { useEffect, useRef, useState } from "preact/hooks";
import { ShimmerBar } from "./primitives/ShimmerBar.jsx";
import { LivePulse } from "./primitives/LivePulse.jsx";
import { StatusPill } from "./primitives/StatusPill.jsx";
import { EventTimeline } from "./EventTimeline.jsx";
import { useRunStream } from "../lib/useRunStream.js";
import { formatMode, runMetricItems } from "../lib/runFormatting.js";

export function LiveRunPanel({ run, events = [], isStreaming = false, agentLabel }) {
  const { events: streamedEvents, loading } = useRunStream(run?.id, { subscribe: isStreaming });
  const visibleEvents = events.length ? events : streamedEvents;
  const prevCountRef = useRef(0);
  const [newestTick, setNewestTick] = useState(0);

  useEffect(() => {
    if ((visibleEvents?.length || 0) > prevCountRef.current) {
      setNewestTick((x) => x + 1);
    }
    prevCountRef.current = visibleEvents?.length || 0;
  }, [visibleEvents]);

  const runStatus = run?.status || (isStreaming ? "running" : "complete");
  const metrics = runMetricItems(run);

  return (
    <section class="card card-spacious task-live-panel">
      {isStreaming && <ShimmerBar height={2} />}
      <header class="task-live-header">
        <div class="task-live-header-copy">
          <span class="task-live-header-info">
            {isStreaming ? <LivePulse size={10} /> : null}
            <span class="task-live-header-label">{isStreaming ? "Live run" : "Latest run"}</span>
          </span>
          <span class="task-live-header-meta">
            {[formatMode(run?.mode), agentLabel || run?.agent_name].filter(Boolean).join(" · ")}
          </span>
        </div>
        <StatusPill status={runStatus} size="sm" />
      </header>
      {metrics.length > 0 && (
        <div class="task-live-metrics" aria-label="Live run metrics">
          {metrics.map(([label, value]) => (
            <span class="run-metric" key={label}>
              <span class="run-metric-label">{label}</span>
              <span class="run-metric-value">{value}</span>
            </span>
          ))}
        </div>
      )}
      <div class="task-live-events" key={`tl-${newestTick}`}>
        {loading ? (
          <div class="run-card-events-loading">Loading events…</div>
        ) : (
          <EventTimeline events={visibleEvents} streaming={isStreaming} />
        )}
      </div>
    </section>
  );
}
