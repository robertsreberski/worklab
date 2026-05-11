import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { assistantViewContextFromLocation } from "../lib/assistantViewContext.js";
import { mergeRunEvents } from "../lib/useRunStream.js";
import { subscribeSharedEventSource } from "../lib/sharedEventSource.js";
import { Icon } from "./Icon.jsx";
import { Button } from "./primitives/Button.jsx";
import { IconButton } from "./primitives/IconButton.jsx";
import { Textarea } from "./primitives/Textarea.jsx";
import { MentionableTextarea } from "./MentionableTextarea.jsx";
import { StatusPill } from "./primitives/StatusPill.jsx";
import { EventTimeline } from "./EventTimeline.jsx";
import { LivePulse } from "./primitives/LivePulse.jsx";
import { Toolbar } from "./layout/index.js";

const HISTORY_PAGE_SIZE = 5;

function messageKey(message) {
  return message?.id || `${message?.role}-${message?.created_at}`;
}

function runStatus(run) {
  return run?.status || "complete";
}

function uniqueMessages(messages) {
  const seen = new Set();
  return messages.filter(Boolean).filter((message) => {
    if (!message?.id) return true;
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function useAssistantRunStream(runId, { subscribe = true, hydrate = true, initialEventLimit = 100 } = {}) {
  const [events, setEvents] = useState([]);
  const [run, setRun] = useState(null);
  const [done, setDone] = useState(false);
  const [donePayload, setDonePayload] = useState(null);

  useEffect(() => {
    if (!runId || !hydrate) {
      setEvents([]);
      setRun(null);
      setDone(false);
      setDonePayload(null);
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    setEvents([]);
    setRun(null);
    setDone(false);
    setDonePayload(null);

    api.getAssistantRun(runId, { events: "tail", limit: String(initialEventLimit) }, { signal: controller.signal })
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

    const unsubscribe = subscribeSharedEventSource(`assistant:${runId}`, `/api/assistant/runs/${encodeURIComponent(runId)}/stream`, (payload) => {
      if (payload.type === "done") {
        if (payload.run) setRun(payload.run);
        setDonePayload(payload);
        setDone(true);
        unsubscribe();
        return;
      }
      setEvents((prev) => mergeRunEvents(prev, [payload]));
    });
    return () => {
      cancelled = true;
      controller.abort();
      unsubscribe();
    };
  }, [runId, subscribe, hydrate, initialEventLimit]);

  return { events, run, done, donePayload };
}

function AssistantRun({ run, active, onDone }) {
  const [open, setOpen] = useState(false);
  const shouldHydrate = !!active || open;
  const stream = useAssistantRunStream(run?.id, {
    subscribe: !!active,
    hydrate: shouldHydrate,
    initialEventLimit: active ? 200 : 100,
  });
  const effectiveRun = stream.run || run;
  const events = useMemo(
    () => mergeRunEvents(run?.events || [], stream.events || []),
    [run?.events, stream.events],
  );
  const streaming = !!(active && runStatus(effectiveRun) === "running" && !stream.done);

  useEffect(() => {
    if (active && stream.done) onDone?.(stream.donePayload);
  }, [active, stream.done, stream.donePayload, onDone]);

  if (!run?.id) return null;
  return (
    <details class="assistant-run" open={active || open} onToggle={(event) => setOpen(event.currentTarget.open)}>
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
      <div class="assistant-run-events wl-scrollbar">
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

export function AssistantDock({
  open,
  onToggle,
  width,
  minWidth,
  maxWidth,
  onResize,
  onResizeBy,
  onResizeTo,
}) {
  const [thread, setThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
  const [historyCursor, setHistoryCursor] = useState(null);
  const [error, setError] = useState("");
  const scrollRef = useRef(null);
  const resizeCleanupRef = useRef(null);
  const preserveScrollRef = useRef(null);
  const skipNextAutoScrollRef = useRef(false);
  const textareaRef = useRef(null);
  const hasLoadedAssistantRef = useRef(false);
  const activeRunId = activeRun?.id || messages.findLast?.((message) => message.role === "assistant" && message.run?.status === "running")?.run?.id;
  const activeMessageId = messages.findLast?.((message) => message.role === "assistant" && message.run?.id === activeRunId)?.id || null;
  const canSend = draft.trim().length > 0 && !sending && !activeRunId;

  async function loadAssistant() {
    setLoading(true);
    setError("");
    try {
      const data = await api.getAssistant({ view: "blank" });
      setThread(data.thread || null);
      setMessages(uniqueMessages(data.messages || []));
      setActiveRun(data.active_run || null);
      setHasOlderHistory(!!data.history?.has_more);
      setHistoryCursor(data.history?.before || data.messages?.[0]?.id || null);
    } catch (err) {
      setError(err?.message || "Assistant is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || hasLoadedAssistantRef.current) return;
    hasLoadedAssistantRef.current = true;
    loadAssistant();
  }, [open]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useLayoutEffect(() => {
    const snapshot = preserveScrollRef.current;
    if (!snapshot) return;
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight - snapshot.scrollHeight + snapshot.scrollTop;
    }
    preserveScrollRef.current = null;
  }, [messages.length]);

  useEffect(() => {
    if (!open) return;
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [open, messages.length, activeRunId]);

  async function loadPreviousConversation() {
    if (!hasOlderHistory || historyLoading) return;
    const node = scrollRef.current;
    if (messages.length && node) {
      preserveScrollRef.current = { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight };
      skipNextAutoScrollRef.current = true;
    }
    setHistoryLoading(true);
    setError("");
    try {
      const query = { limit: String(HISTORY_PAGE_SIZE) };
      if (historyCursor) query.before = historyCursor;
      const data = await api.getAssistantMessages(query);
      const previousMessages = data.messages || [];
      setMessages((current) => uniqueMessages([...previousMessages, ...current]));
      setHistoryCursor(data.history?.next_before || previousMessages[0]?.id || historyCursor);
      setHasOlderHistory(!!data.history?.has_more);
    } catch (err) {
      preserveScrollRef.current = null;
      skipNextAutoScrollRef.current = false;
      setError(err?.message || "Previous conversation was not loaded.");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const body = draft.trim();
    if (!canSend || !body) return;
    setSending(true);
    setError("");
    try {
      const data = await api.sendAssistantMessage(body, assistantViewContextFromLocation(window.location));
      setDraft("");
      setThread(data.thread || thread);
      setMessages((current) => uniqueMessages([...current, data.user_message, data.assistant_message]));
      setActiveRun(data.run || null);
      if (!messages.length) setHistoryCursor(data.user_message?.id || data.assistant_message?.id || historyCursor);
      // Reset autoGrow height and dismiss the iOS soft keyboard so the user
      // can see the reply. Without blurring, the focused textarea keeps iOS
      // in keyboard-open layout for ~700ms after the keyboard visually goes,
      // leaving a phantom band below the composer.
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.blur();
      }
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
      const data = await api.cancelAssistantRun(activeRunId);
      const run = data.run || null;
      if (run) {
        setMessages((current) => current.map((message) => {
          if (message.run?.id !== run.id) return message;
          return {
            ...message,
            body: run.status === "cancelled" && !message.body ? "Assistant run cancelled" : message.body,
            status: run.status === "cancelled" ? "cancelled" : message.status,
            run,
          };
        }));
        setActiveRun(run.status === "running" ? run : null);
      }
    } catch (err) {
      setError(err?.message || "Could not cancel the assistant run.");
    }
  }

  function handleRunDone(payload) {
    if (payload?.message) {
      setMessages((current) => current.map((message) => (
        message.id === payload.message.id ? payload.message : message
      )));
      setActiveRun(null);
      return;
    }
    loadAssistant();
  }

  function startResize(event) {
    if (!onResize || event.button !== 0) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    onResize(event.clientX);
    document.documentElement.classList.add("assistant-resizing");

    const move = (moveEvent) => {
      moveEvent.preventDefault();
      onResize(moveEvent.clientX);
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      document.documentElement.classList.remove("assistant-resizing");
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current = stop;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  }

  function resizeKeyDown(event) {
    if (!onResizeBy || !onResizeTo) return;
    const step = event.shiftKey ? 64 : 24;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onResizeBy(step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onResizeBy(-step);
    } else if (event.key === "Home") {
      event.preventDefault();
      onResizeTo("min");
    } else if (event.key === "End") {
      event.preventDefault();
      onResizeTo("max");
    }
  }

  const body = (
    <aside class={`assistant-dock ${open ? "open" : ""}`.trim()} aria-label="Worklab assistant" aria-hidden={!open}>
      {onResize && (
        <span
          class="assistant-resize-handle"
          role="separator"
          tabIndex={open ? 0 : -1}
          aria-label="Resize assistant"
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={Math.round(width || 0)}
          onPointerDown={startResize}
          onKeyDown={resizeKeyDown}
        />
      )}
      <header class="assistant-dock-head">
        <div class="assistant-title">
          <span class="assistant-title-icon"><Icon name="sparkles" size={15} /></span>
          <div>
            <h2>Assistant</h2>
            <span>{thread?.title || "Personal assistant"}</span>
          </div>
        </div>
        <Toolbar class="assistant-head-actions">
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
        </Toolbar>
      </header>
      <div class="assistant-thread wl-scrollbar" ref={scrollRef}>
        {!loading && hasOlderHistory && (
          <div class="assistant-history-action">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              loading={historyLoading}
              onClick={loadPreviousConversation}
              iconLeft={<Icon name="chevron-up" size={13} />}
            >
              Load previous conversation
            </Button>
          </div>
        )}
        {loading && !messages.length ? (
          <div class="assistant-empty">Loading assistant...</div>
        ) : messages.length ? (
          messages.map((message) => (
            <AssistantMessage
              key={messageKey(message)}
              message={message}
              active={message.id === activeMessageId}
              onRunDone={handleRunDone}
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
        <MentionableTextarea
          rows={2}
          autoGrow
          inputRef={textareaRef}
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
          class="assistant-composer-submit"
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
        <button type="button" class="assistant-launcher" onClick={onToggle} aria-label="Open assistant" title="Open assistant (⌘\\)">
          <Icon name="message-circle" size={18} />
          {activeRunId && <span class="assistant-launcher-dot" aria-hidden="true" />}
        </button>
      )}
      {body}
    </>
  );
}
