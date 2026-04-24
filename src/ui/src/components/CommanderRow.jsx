// §4.4 CommanderRow — the canonical dense task row.
// Grid: 16 · 64 · 12 · 1fr · 80 · 104 · 56. Blocked-by wins over priority.
// Error chip policy (§5.3): derived from last_run.status === 'error'.

import { useMemo } from "preact/hooks";
import { useRunStream } from "../lib/useRunStream.js";
import { useLiveTicker } from "../lib/useLiveTicker.js";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { Icon } from "./Icon.jsx";
import { StatusPill, statusMeta } from "./primitives/StatusPill.jsx";
import { StatusDot } from "./primitives/StatusDot.jsx";
import { LivePulse } from "./primitives/LivePulse.jsx";
import { ToolToken } from "./primitives/ToolToken.jsx";
import { PriorityChip } from "./primitives/PriorityChip.jsx";
import { agentDisplayName } from "../lib/display.js";

function formatAge(value) {
  if (!value) return "";
  const ms = Date.now() - Number(value);
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 86_400_000 * 7) return `${Math.floor(ms / 86_400_000)}d`;
  return new Date(Number(value)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function taskIdDisplay(id) {
  const raw = String(id || "");
  if (raw.startsWith("task_")) return raw.slice(5, 11).toUpperCase();
  return raw.slice(0, 6).toUpperCase();
}

// Derive which run is currently streaming. Prefer the explicit running_run_id
// field (§9.3 backend fix) and fall back to inspecting the attached runs array.
function runningRunIdFromTask(task) {
  if (!task) return null;
  if (task.running_run_id) return task.running_run_id;
  const runs = task.runs;
  if (!Array.isArray(runs)) return null;
  const live = runs.find((r) => r.status === "running");
  return live?.id || null;
}

// §5.3 error-chip policy: only derived from last_run.status === 'error'.
function hasRunError(task) {
  if (!task) return false;
  if (task.last_run?.status === "error") return true;
  if (Array.isArray(task.runs) && task.runs.length) {
    const last = task.runs[task.runs.length - 1];
    if (last?.status === "error") return true;
  }
  return false;
}

export function CommanderRow({ task, agents = [], selected = false, onClick }) {
  const runningRunId = runningRunIdFromTask(task);
  const isStreaming = !!runningRunId;
  const { events } = useRunStream(runningRunId, { subscribe: isStreaming });
  const recentEvents = useMemo(() => {
    if (!isStreaming) return [];
    return (events || []).slice(-6);
  }, [events, isStreaming]);
  const event = useLiveTicker(recentEvents, { running: isStreaming, intervalMs: 2200 });
  const meta = statusMeta(task.status);

  const executorLabel = agentDisplayName(agents, task.executor_agent, "Unassigned");
  const reviewerLabel = agentDisplayName(agents, task.reviewer_agent, null);

  const blockedCount = Array.isArray(task.blocked_by) ? task.blocked_by.length : 0;
  const runError = hasRunError(task);
  const needsExecutor = !task.executor_agent && task.status !== "done";

  return (
    <a
      href={`#/tasks/${task.id}`}
      class={`commander-row ${selected ? "selected" : ""} ${isStreaming && event ? "running" : ""}`}
      onClick={onClick}
    >
      <div class="commander-cell-checkbox">
        <span class="commander-checkbox" aria-hidden="true" />
      </div>
      <span class="commander-cell-id">{taskIdDisplay(task.id)}</span>
      <span class="commander-cell-status">
        {isStreaming ? (
          <LivePulse color={meta.color} size={10} />
        ) : (
          <StatusDot status={task.status} size={8} />
        )}
      </span>
      <div class="commander-cell-title">
        <div class="commander-cell-title-row">
          <span class="commander-title">{task.title}</span>
          {/* §4.4: blocked-by wins over priority */}
          {blockedCount > 0 ? (
            <span class="blocked-chip">
              <Icon name="lock" size={10} /> Blocked by {blockedCount}
            </span>
          ) : (
            <PriorityChip priority={task.priority} />
          )}
          {runError && (
            <span class="chip chip-error">
              <Icon name="alert-triangle" size={10} /> Error
            </span>
          )}
          {needsExecutor && (
            <span class="chip chip-warn">Needs executor</span>
          )}
        </div>
        {isStreaming && event && (
          <div class="commander-live-line" key={`${task.id}-${event.ts || event.t || 0}`}>
            <ToolToken event={event} compact />
          </div>
        )}
      </div>
      <div class="commander-cell-assignees">
        <AgentAvatar
          name={task.executor_agent}
          label={executorLabel}
          size={20}
          title={`Executor: ${executorLabel}`}
        />
        {task.reviewer_agent && (
          <AgentAvatar
            name={task.reviewer_agent}
            label={reviewerLabel}
            size={20}
            title={`Reviewer: ${reviewerLabel}`}
          />
        )}
      </div>
      <div class="commander-cell-pill">
        <StatusPill status={task.status} size="sm" />
      </div>
      <div class="commander-cell-age">{formatAge(task.updated_at)}</div>
    </a>
  );
}
