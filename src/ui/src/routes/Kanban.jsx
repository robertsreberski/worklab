import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { pushToast } from "../lib/toast.js";
import { NewTaskModal } from "../components/NewTaskModal.jsx";
import { SelectField } from "../components/SelectField.jsx";

const STATUSES = ["todo", "in_progress", "in_review", "done"];
const STATUS_LABELS = { todo: "Todo", in_progress: "In progress", in_review: "In review", done: "Done" };
const STATUS_OPTIONS = STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }));

function formatAge(value) {
  if (!value) return "";
  const ms = Date.now() - Number(value);
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  const date = new Date(Number(value));
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function truncate(text, limit = 150) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function TaskMeta({ task }) {
  const items = [
    task.executor_agent ? `Executor ${task.executor_agent}` : "No executor",
    task.reviewer_agent ? `Reviewer ${task.reviewer_agent}` : null,
    task.priority ? `P${task.priority}` : null,
    task.retry_count ? `${task.retry_count} retries` : null,
    `Updated ${formatAge(task.updated_at)}`,
  ].filter(Boolean);
  return (
    <div class="issue-row-meta">
      {items.map((item) => <span key={item}>{item}</span>)}
    </div>
  );
}

function IssueRow({ task, onStatusChange }) {
  const description = truncate(task.description || task.instructions);
  return (
    <div class={`issue-row ${task.error_text ? "issue-row-error" : ""}`}>
      <a class="issue-row-link" href={`#/tasks/${task.id}`}>
        <span class={`issue-status-dot ${task.status}`} aria-hidden="true" />
        <span class="issue-row-main">
          <span class="issue-row-head">
            <span class="issue-id">{task.id}</span>
            <span class="issue-title">{task.title}</span>
            {task.error_text && <span class="status-badge error">Error</span>}
          </span>
          {description && <span class="issue-row-preview">{description}</span>}
          <TaskMeta task={task} />
        </span>
      </a>
      <div class="issue-row-actions">
        <SelectField
          class="issue-status-select"
          value={task.status}
          options={STATUS_OPTIONS}
          ariaLabel={`Status for ${task.title}`}
          onChange={(status) => onStatusChange(task, status)}
        />
      </div>
    </div>
  );
}

export function Kanban() {
  const [tasks, setTasks] = useState([]);
  const [showNew, setShowNew] = useState(false);

  const reload = useCallback(() => {
    api.listTasks().then((r) => setTasks(r.tasks));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => {
    if (["task_created", "task_updated", "task_deleted"].includes(evt.type)) reload();
  });

  function onStatusChange(task, status) {
    if (!task || task.status === status) return;
    const previous = task.status;
    setTasks((items) => items.map((item) => (item.id === task.id ? { ...item, status } : item)));
    api.patchTask(task.id, { status }).catch((err) => {
      pushToast(`Move failed (${STATUS_LABELS[previous]} -> ${STATUS_LABELS[status]}): ${err.message}`, { variant: "error" });
      reload();
    });
  }

  const counts = Object.fromEntries(STATUSES.map((status) => [
    status,
    tasks.filter((task) => task.status === status).length,
  ]));
  const blockedCount = tasks.filter((task) => task.error_text).length;
  const activeCount = counts.in_progress + counts.in_review;

  return (
    <div class="tasks-page">
      <div class="tasks-toolbar">
        <div>
          <div class="eyebrow">Task queue</div>
          <h2 class="page-title">Agent work</h2>
          <div class="tasks-summary">
            <span>{tasks.length} total</span>
            <span>{activeCount} active</span>
            <span class={blockedCount ? "error" : ""}>{blockedCount ? `${blockedCount} blocked` : "No errors"}</span>
          </div>
        </div>
        <div class="toolbar">
          <button class="primary" onClick={() => setShowNew(true)}>New task</button>
          <button onClick={reload}>Refresh</button>
        </div>
      </div>

      <div class="issue-list">
        {STATUSES.map((status) => {
          const rows = tasks.filter((task) => task.status === status);
          return (
            <section class="issue-section" key={status}>
              <div class="issue-section-header">
                <div>
                  <span class={`issue-status-dot ${status}`} aria-hidden="true" />
                  <span>{STATUS_LABELS[status]}</span>
                </div>
                <span>{rows.length}</span>
              </div>
              {rows.length === 0 ? (
                <div class="issue-section-empty">
                  {status === "todo" ? (
                    <button type="button" class="link-button" onClick={() => setShowNew(true)}>New task</button>
                  ) : "No tasks in this state."}
                </div>
              ) : (
                rows.map((task) => (
                  <IssueRow key={task.id} task={task} onStatusChange={onStatusChange} />
                ))
              )}
            </section>
          );
        })}
      </div>

      {showNew && (
        <NewTaskModal
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); reload(); }}
        />
      )}
    </div>
  );
}
