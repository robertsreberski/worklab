// §5.5 LiveRunPanel — cinematic per-event reveal for the currently streaming run.
// Uses the AgentEventTimeline internally (preserves heavy rendering) but adds a
// ShimmerBar at the top while the run is streaming and tracks incoming events so
// that the newest row animates in via wl-tick-in.

import { useState } from "preact/hooks";
import { ShimmerBar } from "./primitives/ShimmerBar.jsx";
import { StatusPill } from "./primitives/StatusPill.jsx";
import { Button } from "./primitives/Button.jsx";
import { Textarea } from "./primitives/Textarea.jsx";
import { Card } from "./Card.jsx";
import { Icon } from "./Icon.jsx";
import { EventTimeline } from "./EventTimeline.jsx";
import { RunHistoryNotice } from "./RunHistoryNotice.jsx";
import { SectionGroup } from "./layout/index.js";
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

function normalizeTodoForPanel(todo) {
  if (!todo?.content || !todo?.status) return null;
  const content = String(todo.content);
  const status = String(todo.status);
  const activeForm = todo.active_form ? String(todo.active_form) : "";
  const normalized = {
    content,
    status,
    label: status === "in_progress" && activeForm ? activeForm : content,
  };
  if (activeForm) normalized.active_form = activeForm;
  return normalized;
}

export function liveRunTodoPanelState(run) {
  const todos = Array.isArray(run?.todo_state?.todos)
    ? run.todo_state.todos.map(normalizeTodoForPanel).filter(Boolean)
    : [];
  const current = todos.find((todo) => todo.status === "in_progress") || null;
  const pending = todos.filter((todo) => todo.status === "pending");
  const completed = todos.filter((todo) => todo.status === "completed");
  const completedCount = completed.length;
  return {
    visible: todos.length > 0,
    current,
    pending,
    completed,
    completedCount,
    total: todos.length,
    updatedAt: run?.todo_state?.updated_at || null,
  };
}

function TodoStatusIcon({ status }) {
  if (status === "completed") return <Icon name="check" size={14} />;
  if (status === "in_progress") return <Icon name="clock" size={14} />;
  return <Icon name="circle" size={12} />;
}

function TodoRow({ todo, tone = "" }) {
  return (
    <li class={`task-live-todo-row ${tone ? `task-live-todo-row-${tone}` : ""}`}>
      <span class="task-live-todo-icon"><TodoStatusIcon status={todo.status} /></span>
      <span class="task-live-todo-copy">
        <span class="task-live-todo-content">{todo.label || todo.content}</span>
      </span>
    </li>
  );
}

export function RunTodoPanel({ run }) {
  const todoPanel = liveRunTodoPanelState(run);
  if (!todoPanel.visible) return null;
  const extraPending = Math.max(0, todoPanel.pending.length - 4);
  return (
    <SectionGroup
      class="task-live-todos"
      aria-label="Run todo list"
      label={(
        <>
          <Icon name="layout-list" size={14} />
          <span>Checklist</span>
        </>
      )}
      count={`${todoPanel.completedCount}/${todoPanel.total}`}
    >
      <ul class="task-live-todos-list">
        {todoPanel.current && <TodoRow todo={todoPanel.current} tone="active" />}
        {todoPanel.pending.slice(0, 4).map((todo, index) => (
          <TodoRow todo={todo} key={`${todo.content}-${index}`} />
        ))}
        {extraPending > 0 && (
          <li class="task-live-todo-row task-live-todo-row-muted">
            <span class="task-live-todo-icon"><Icon name="more-horizontal" size={14} /></span>
            <span class="task-live-todo-copy">{extraPending} more pending</span>
          </li>
        )}
        {todoPanel.completed.map((todo, index) => (
          <TodoRow todo={todo} tone="completed" key={`${todo.content}-${index}`} />
        ))}
      </ul>
    </SectionGroup>
  );
}

export function LiveRunPanel({ run, events = [], isStreaming = false, agentLabel, streamState = null }) {
  const fallbackStream = useRunStream(streamState ? null : run?.id, { subscribe: isStreaming });
  const effectiveStream = streamState || fallbackStream;
  const effectiveRun = effectiveStream.run || run;
  const visibleEvents = events.length ? events : effectiveStream.events;
  const loading = effectiveStream.loading;
  const rawLogHref = effectiveRun?.raw_output_path && effectiveRun?.id
    ? `/api/runs/${encodeURIComponent(effectiveRun.id)}/raw-log`
    : null;
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
    <Card variant="spacious" class="task-live-panel">
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
      <RunTodoPanel run={effectiveRun} />
      <RunHistoryNotice
        eventCount={effectiveStream.eventCount}
        visibleCount={visibleEvents.length}
        eventsTruncated={effectiveStream.eventsTruncated}
        fullHistoryLoaded={effectiveStream.fullHistoryLoaded}
        loading={loading}
        onLoadFullHistory={effectiveStream.loadFullHistory}
        rawLogHref={rawLogHref}
      />
      <div class="task-live-events">
        {loading && visibleEvents.length === 0 ? (
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
    </Card>
  );
}
