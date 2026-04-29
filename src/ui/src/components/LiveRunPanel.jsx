// §5.5 LiveRunPanel — cinematic per-event reveal for the currently streaming run.
// Uses the AgentEventTimeline internally (preserves heavy rendering) but adds a
// ShimmerBar at the top while the run is streaming and tracks incoming events so
// that the newest row animates in via wl-tick-in.

import { useState } from "preact/hooks";
import { ShimmerBar } from "./primitives/ShimmerBar.jsx";
import { StatusPill } from "./primitives/StatusPill.jsx";
import { Button } from "./primitives/Button.jsx";
import { Textarea } from "./primitives/Textarea.jsx";
import { Icon } from "./Icon.jsx";
import { EventTimeline } from "./EventTimeline.jsx";
import { useRunStream } from "../lib/useRunStream.js";
import { formatMode, runMetricItems } from "../lib/runFormatting.js";
import { api } from "../lib/api.js";

const LIVE_INPUT_PROVIDER_KINDS = new Set(["claude", "openai", "vercel", "codex", "pi"]);

export function liveRunComposerState(run, isStreaming = false) {
  const liveInput = run?.live_input || {};
  const providerKind = String(run?.provider_kind || "");
  const supportedByProvider = LIVE_INPUT_PROVIDER_KINDS.has(providerKind);
  const supported = liveInput.supported === true || (liveInput.supported !== false && supportedByProvider);
  const visible = Boolean(isStreaming && supported && run?.id);
  return {
    visible,
    canEdit: visible,
    canSend: visible && liveInput.active !== false,
  };
}

export function LiveRunPanel({ run, events = [], isStreaming = false, agentLabel }) {
  const { events: streamedEvents, run: streamedRun, loading } = useRunStream(run?.id, { subscribe: isStreaming });
  const effectiveRun = streamedRun || run;
  const visibleEvents = events.length ? events : streamedEvents;
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const runStatus = effectiveRun?.process_status || effectiveRun?.status || (isStreaming ? "running" : "complete");
  const metrics = runMetricItems(effectiveRun);
  const composer = liveRunComposerState(effectiveRun, isStreaming);
  const canEdit = composer.canEdit;
  const canSend = composer.canSend;
  const trimmedMessage = message.trim();

  async function submitMessage(event) {
    event.preventDefault();
    if (!canSend || !trimmedMessage || sending) return;
    setSending(true);
    setError("");
    try {
      await api.sendRunMessage(effectiveRun.id, trimmedMessage);
      setMessage("");
    } catch (err) {
      setError(err?.message || "Message was not delivered.");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    if (!canSend || !trimmedMessage || sending) return;
    submitMessage(event);
  }

  return (
    <section class="card card-spacious task-live-panel">
      {isStreaming && <ShimmerBar height={2} />}
      <header class="task-live-header">
        <div class="task-live-header-copy">
          <span class="task-live-header-info">
            <span class="task-live-header-label">{isStreaming ? "Live run" : "Latest run"}</span>
          </span>
          <span class="task-live-header-meta">
            {[formatMode(effectiveRun?.mode), agentLabel || effectiveRun?.agent_name].filter(Boolean).join(" · ")}
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
      <div class="task-live-events">
        {loading ? (
          <div class="run-card-events-loading">Loading events…</div>
        ) : (
          <EventTimeline events={visibleEvents} streaming={isStreaming} />
        )}
      </div>
      {composer.visible && (
        <form class="task-live-composer" onSubmit={submitMessage}>
          <Textarea
            rows={1}
            autoGrow
            class="task-live-composer-input"
            placeholder="Guide this run..."
            value={message}
            disabled={!canEdit || sending}
            onInput={(event) => setMessage(event.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Live run message"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={sending}
            disabled={!canSend || !trimmedMessage || sending}
            iconLeft={<Icon name="send" size={14} />}
            aria-label="Send live run message"
          />
          {error && <div class="task-live-composer-error">{error}</div>}
        </form>
      )}
    </section>
  );
}
