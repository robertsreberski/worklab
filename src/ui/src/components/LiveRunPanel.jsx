// §5.5 LiveRunPanel — cinematic per-event reveal for the currently streaming run.
// Uses the AgentEventTimeline internally (preserves heavy rendering) but adds a
// ShimmerBar at the top while the run is streaming and tracks incoming events so
// that the newest row animates in via wl-tick-in.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ShimmerBar } from "./primitives/ShimmerBar.jsx";
import { LivePulse } from "./primitives/LivePulse.jsx";
import { StatusPill } from "./primitives/StatusPill.jsx";
import { EventTimeline } from "./EventTimeline.jsx";

export function LiveRunPanel({ run, events = [], isStreaming = false }) {
  const prevCountRef = useRef(0);
  const [newestTick, setNewestTick] = useState(0);

  useEffect(() => {
    if ((events?.length || 0) > prevCountRef.current) {
      setNewestTick((x) => x + 1);
    }
    prevCountRef.current = events?.length || 0;
  }, [events]);

  const runStatus = run?.status || (isStreaming ? "running" : "complete");

  return (
    <section class="card card-spacious task-live-panel">
      {isStreaming && <ShimmerBar height={2} />}
      <header class="task-live-header">
        <span class="task-live-header-info">
          {isStreaming ? <LivePulse size={10} /> : null}
          <span class="task-live-header-label">{isStreaming ? "Live run" : "Latest run"}</span>
        </span>
        <StatusPill status={runStatus} size="sm" />
      </header>
      <div key={`tl-${newestTick}`}>
        <EventTimeline events={events} streaming={isStreaming} />
      </div>
    </section>
  );
}
