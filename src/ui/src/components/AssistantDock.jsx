import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { mergeRunEvents } from "../lib/useRunStream.js";
import { Icon } from "./Icon.jsx";
import { Button } from "./primitives/Button.jsx";
import { IconButton } from "./primitives/IconButton.jsx";
import { Textarea } from "./primitives/Textarea.jsx";
import { StatusPill } from "./primitives/StatusPill.jsx";
import { EventTimeline } from "./EventTimeline.jsx";
import { LivePulse } from "./primitives/LivePulse.jsx";

function messageKey(message) {
  return message?.id || `${message?.role}-${message?.created_at}`;
}

function runStatus(run) {
  return run?.status || "complete";
}

function useAssistantRunStream(runId, { subscribe = true } = {}) {
  const [events, setEvents] = useState([]);
  const [run, setRun] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!runId) {
      setEvents([]);
      setRun(null);
      setDone(false);
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    setEvents([]);
    setRun(null);
    setDone(false);

    api.getAssistantRun(runId)
      .then((data) => {
        if (cancelled) return;
        if (data?.run) {
          setRun(data.run);
          if (data.run.events?.length) setEvents((prev) => mergeRunEvents(prev, data.run.events));
          if (data.run.status && data.run.status !== "running") setDone(true);
        }
      })
      .catch(() => {});

    if (!subscribe) return () => { cancelled = true; controller.abort(); };

    const es = new EventSource(`/api/assistant/runs/${runId}/stream`);
    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "done") {
          setDone(true);
          es.close();
          return;
        }
        setEvents((prev) => mergeRunEvents(prev, [payload]));
      } catch {}
    };
    es.onerror = () => { es.close(); };
    return () => {
      cancelled = true;
      controller.abort();
      es.close();
    };
  }, [runId, subscribe]);

  return { events, run, done };
}

function AssistantRun({ run, active, onDone }) {
  const stream = useAssistantRunStream(run?.id, { subscribe: !!active });
  const effectiveRun = stream.run || run;
  const events = useMemo(
    () => mergeRunEvents(run?.events || [], stream.events || []),
    [run?.events, stream.events],
  );
  const streaming = !!(active && runStatus(effectiveRun) === "running" && !stream.done);

  useEffect(() => {
    if (active && stream.done) onDone?.();
  }, [active, stream.done, onDone]);

  if (!run?.id) return null;
  return (
    <details class="assistant-run">
      <summary class="assistant-run-head">
        <span class="assistant-run-label">
          {streaming && <LivePulse size={8} />}
          Agent run
        </span>
        <span class="assistant-run-meta">
          <StatusPill status={runStatus(effectiveRun)} size="sm" />
          <Icon name="chevron-down" size={14} class="assistant-run-chevron" />
        </span>
      </summary>
      <div class="assistant-run-events">
        <EventTimeline events={events} streaming={streaming} />
      </div>
    </details>
  );
}

function AssistantMessage({ message, active, onRunDone }) {
  const isUser = message.role === "user";
  return (
    <article class={`assistant-message ${isUser ? "user" : "assistant"}`.trim()}>
      <div class="assistant-message-meta">
        <span>{isUser ? "Robert" : "Assistant"}</span>
      </div>
      <div class="assistant-bubble">
        {message.body ? (
          <div class="assistant-bubble-text">{message.body}</div>
        ) : (
          <div class="assistant-bubble-muted">Working...</div>
        )}
        {!isUser && message.run && (
          <AssistantRun run={message.run} active={active} onDone={onRunDone} />
        )}
      </div>
    </article>
  );
}

export function AssistantDock({ open, onToggle }) {
  const [thread, setThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef(null);
  const activeRunId = activeRun?.id || messages.findLast?.((message) => message.role === "assistant" && message.run?.status === "running")?.run?.id;
  const activeMessageId = messages.findLast?.((message) => message.role === "assistant" && message.run?.id === activeRunId)?.id || null;
  const canSend = draft.trim().length > 0 && !sending && !activeRunId;

  async function loadAssistant() {
    setLoading(true);
    setError("");
    try {
      const data = await api.getAssistant();
      setThread(data.thread || null);
      setMessages(data.messages || []);
      setActiveRun(data.active_run || null);
    } catch (err) {
      setError(err?.message || "Assistant is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAssistant();
  }, []);

  useEffect(() => {
    if (!open) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [open, messages.length, activeRunId]);

  async function submit(event) {
    event.preventDefault();
    const body = draft.trim();
    if (!canSend || !body) return;
    setSending(true);
    setError("");
    try {
      const data = await api.sendAssistantMessage(body);
      setDraft("");
      setThread(data.thread || thread);
      setMessages((current) => [...current, data.user_message, data.assistant_message].filter(Boolean));
      setActiveRun(data.run || null);
    } catch (err) {
      setError(err?.message || "Message was not sent.");
    } finally {
      setSending(false);
    }
  }

  function keyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    if (!canSend) return;
    submit(event);
  }

  async function cancelActiveRun() {
    if (!activeRunId) return;
    try {
      await api.cancelAssistantRun(activeRunId);
      await loadAssistant();
    } catch (err) {
      setError(err?.message || "Could not cancel the assistant run.");
    }
  }

  const body = (
    <aside class={`assistant-dock ${open ? "open" : ""}`.trim()} aria-label="Worklab assistant" aria-hidden={!open}>
      <header class="assistant-dock-head">
        <div class="assistant-title">
          <span class="assistant-title-icon"><Icon name="sparkles" size={15} /></span>
          <div>
            <h2>Assistant</h2>
            <span>{thread?.title || "Personal assistant"}</span>
          </div>
        </div>
        <div class="assistant-head-actions">
          {activeRunId && (
            <IconButton
              icon={<Icon name="stop" size={14} />}
              aria-label="Cancel assistant run"
              onClick={cancelActiveRun}
            />
          )}
          <IconButton
            icon={<Icon name="chevron-right" size={14} />}
            aria-label="Collapse assistant"
            onClick={onToggle}
          />
        </div>
      </header>
      <div class="assistant-thread" ref={scrollRef}>
        {loading && !messages.length ? (
          <div class="assistant-empty">Loading assistant...</div>
        ) : messages.length ? (
          messages.map((message) => (
            <AssistantMessage
              key={messageKey(message)}
              message={message}
              active={message.id === activeMessageId}
              onRunDone={loadAssistant}
            />
          ))
        ) : (
          <div class="assistant-empty">
            <Icon name="message-circle" size={18} />
            <span>Ask for tasks, agents, skills, memory, or Worklab changes.</span>
          </div>
        )}
      </div>
      <form class="assistant-composer" onSubmit={submit}>
        {error && <div class="assistant-error">{error}</div>}
        <Textarea
          rows={2}
          autoGrow
          value={draft}
          onInput={(event) => setDraft(event.target.value)}
          onKeyDown={keyDown}
          placeholder={activeRunId ? "Assistant is running..." : "Ask Worklab..."}
          disabled={sending || !!activeRunId}
          aria-label="Assistant message"
        />
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={sending}
          disabled={!canSend}
          iconLeft={<Icon name="send" size={14} />}
          aria-label="Send assistant message"
        />
      </form>
    </aside>
  );

  return (
    <>
      {!open && (
        <button type="button" class="assistant-launcher" onClick={onToggle} aria-label="Open assistant">
          <Icon name="message-circle" size={18} />
          {activeRunId && <span class="assistant-launcher-dot" aria-hidden="true" />}
        </button>
      )}
      {body}
    </>
  );
}
