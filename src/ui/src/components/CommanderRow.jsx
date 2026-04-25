// §4.4 CommanderRow — the canonical dense task row.
// Dense grid (matches DS prototype VariationA):
//   checkbox · id · title+live · deps-chip · executor→reviewer · status-pill · age
// Error chip policy (§5.3): derived from last_run.status === 'error'.
// "Stuck" chip: status==="in_progress" && is_locked===false (§5.2).

import { useMemo } from "preact/hooks";
import { useRunStream } from "../lib/useRunStream.js";
import { useLiveTicker } from "../lib/useLiveTicker.js";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { Icon } from "./Icon.jsx";
import { StatusPill, statusMeta } from "./primitives/StatusPill.jsx";
import { LivePulse } from "./primitives/LivePulse.jsx";
import { ToolToken } from "./primitives/ToolToken.jsx";
import { Checkbox } from "./primitives/Checkbox.jsx";
import { agentDisplayName, hasRunError } from "../lib/display.js";

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

export function CommanderRow({
  task,
  agents = [],
  selected = false,
  checked = false,
  onSelect,
  onToggleCheck,
  onOpen,
}) {
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

  const blockedCount = Array.isArray(task.blocked_by)
    ? task.blocked_by.filter((dependency) => dependency.status !== "done").length
    : 0;
  const runError = hasRunError(task);
  const stuck = task.status === "in_progress" && task.is_locked === false;
  const needsExecutor = !task.executor_agent && task.status !== "done";

  // Title-row chip — disambiguates the reason a task lives in Blocked or
  // warns the user a worker is missing. Order: stuck > error > needs-executor.
  // Blocked-by gets its own grid cell (.commander-cell-deps).
  let metaChip = null;
  if (stuck) {
    metaChip = (
      <span class="chip chip-error">
        <Icon name="alert-triangle" size={10} /> Stuck — reset
      </span>
    );
  } else if (runError) {
    metaChip = (
      <span class="chip chip-error">
        <Icon name="alert-triangle" size={10} /> Error
      </span>
    );
  } else if (needsExecutor) {
    metaChip = <span class="chip chip-warn">Needs executor</span>;
  }

  const depsChip = blockedCount > 0 ? (
    <span class="blocked-chip">
      <Icon name="lock" size={10} /> Blocked by {blockedCount}
    </span>
  ) : null;

  return (
    <div
      class={`commander-row ${selected ? "selected" : ""} ${isStreaming && event ? "running" : ""}`}
      role="button"
      tabIndex={-1}
      onClick={() => {
        onSelect?.();
        onOpen?.();
      }}
      onMouseEnter={() => onSelect?.()}
    >
      <div
        class="commander-cell-checkbox"
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          checked={checked}
          onChange={(nextChecked, event) => {
            event?.stopPropagation?.();
            onSelect?.();
            onToggleCheck?.(nextChecked);
          }}
          label={<span class="sr-only">Select task {task.title}</span>}
        />
      </div>
      <span class="commander-cell-id">{taskIdDisplay(task.id)}</span>
      <span class="commander-cell-state" aria-hidden="true">
        {isStreaming
          ? <LivePulse color={meta.color} size={8} />
          : <span class="commander-state-dot" style={{ "--dot-color": meta.color }} />}
      </span>
      <div class="commander-cell-title">
        <div class="commander-cell-title-row">
          <span class="commander-title">{task.title}</span>
          {metaChip}
        </div>
        {isStreaming && event && (
          <div class="commander-live-line" key={`${task.id}-${event.ts || event.t || 0}`}>
            <ToolToken event={event} compact />
          </div>
        )}
      </div>
      <div class="commander-cell-deps">{depsChip}</div>
      <div class="commander-cell-assignees">
        <AgentAvatar
          name={task.executor_agent}
          label={executorLabel}
          size={20}
          title={`Executor: ${executorLabel}`}
        />
        {task.reviewer_agent && (
          <>
            <Icon name="arrow-right" size={10} class="commander-cell-arrow" />
            <AgentAvatar
              name={task.reviewer_agent}
              label={reviewerLabel}
              size={20}
              title={`Reviewer: ${reviewerLabel}`}
            />
          </>
        )}
      </div>
      <div class="commander-cell-pill">
        <StatusPill status={task.status} size="sm" />
      </div>
      <div class="commander-cell-age">{formatAge(task.updated_at)}</div>
    </div>
  );
}
