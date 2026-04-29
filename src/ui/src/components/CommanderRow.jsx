// §4.4 CommanderRow — the canonical dense task row.
// Dense grid:
//   checkbox · id · title+live · deps-chip · planner/owner/reviewer · status-pill · age
// Error chip policy (§5.3): derived from last_run.status === 'error'.
// "Stuck" chip: running_run_id && is_locked===false (§5.2).

import { useMemo } from "preact/hooks";
import { mergeRunEvents, useRunStream } from "../lib/useRunStream.js";
import { useLiveTicker } from "../lib/useLiveTicker.js";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { Icon } from "./Icon.jsx";
import { statusMeta } from "./primitives/StatusPill.jsx";
import { StageToken } from "./primitives/StageToken.jsx";
import { LivePulse } from "./primitives/LivePulse.jsx";
import { ToolToken } from "./primitives/ToolToken.jsx";
import { Checkbox } from "./primitives/Checkbox.jsx";
import { agentDisplayName, hasRunError, taskDisplayKey } from "../lib/display.js";

function formatAge(value) {
  if (!value) return "";
  const ms = Date.now() - Number(value);
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 86_400_000 * 7) return `${Math.floor(ms / 86_400_000)}d`;
  return new Date(Number(value)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Derive which run is currently streaming. Prefer the explicit running_run_id
// field (§9.3 backend fix) and fall back to inspecting the attached runs array.
function runningRunIdFromTask(task) {
  if (!task) return null;
  if (task.running_run_id) return task.running_run_id;
  const runs = task.runs;
  if (!Array.isArray(runs)) return null;
  const live = runs.find((r) => (r.process_status || r.status) === "running");
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
    const initial = task.running_run?.last_event ? [task.running_run.last_event] : [];
    return mergeRunEvents(initial, events || []).slice(-6);
  }, [events, isStreaming, task.running_run?.last_event]);
  const event = useLiveTicker(recentEvents, { running: isStreaming, intervalMs: 2200 });
  const displayStage = task.stage || "plan";
  const meta = statusMeta(task.running_run_id ? "running" : displayStage);

  const runnerName = task.owner_agent;
  const runnerRole = "Owner";
  const runnerLabel = agentDisplayName(agents, runnerName, "Unassigned");
  const plannerLabel = agentDisplayName(agents, task.planner_agent, null);
  const reviewerLabel = agentDisplayName(agents, task.reviewer_agent, null);

  const blockedCount = Array.isArray(task.blocked_by)
    ? task.blocked_by.filter((dependency) => (dependency.stage || "plan") !== "done").length
    : 0;
  const runError = hasRunError(task);
  const stuck = task.running_run_id && task.is_locked === false;
  const needsOwner = !runnerName && displayStage !== "done";
  const autoRun = task.run_policy === "auto_plan_execute";
  const schedule = task.automation_summary || {};
  const hasSchedule = Number(schedule.count || 0) > 0;
  const scheduleEnabled = Number(schedule.enabled_count || 0) > 0;
  const scheduleTitle = schedule.next_fire_at
    ? `Next scheduled run: ${new Date(schedule.next_fire_at).toLocaleString()}`
    : (hasSchedule ? "Task schedule is paused" : undefined);

  // Title-row chip — surfaces warnings without changing the stage grouping.
  // Order: stuck > error > needs-owner.
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
  } else if (needsOwner) {
    metaChip = <span class="chip chip-warn">Needs owner</span>;
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
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") onSelect?.();
      }}
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
      <span class="commander-cell-id">{taskDisplayKey(task)}</span>
      <span class="commander-cell-state" aria-hidden="true">
        {isStreaming
          ? <LivePulse color={meta.color} size={8} />
          : <span class="commander-state-dot" style={{ "--dot-color": meta.color }} />}
      </span>
      <div class="commander-cell-title">
        <div class="commander-cell-title-row">
          <span class="commander-title">{task.title}</span>
          {task.project && (
            <span class="chip chip-muted commander-project-chip" title={`Project: ${task.project.name || task.project.slug}`}>
              <Icon name="folder" size={10} /> {task.project.name || task.project.slug}
            </span>
          )}
          {metaChip}
          {autoRun && (
            <span class="chip">
              <Icon name="zap" size={10} /> Auto-run
            </span>
          )}
          {hasSchedule && (
            <span class={`chip ${scheduleEnabled ? "chip-trigger" : "chip-muted"}`} title={scheduleTitle}>
              <Icon name={scheduleEnabled ? "clock" : "minus-circle"} size={10} /> {scheduleEnabled ? "Scheduled" : "Schedule paused"}
            </span>
          )}
        </div>
      </div>
      <div class="commander-cell-deps">{depsChip}</div>
      <div class="commander-cell-assignees">
        {task.planner_agent && (
          <>
            <AgentAvatar
              name={task.planner_agent}
              label={plannerLabel}
              role="planner"
              size={20}
              title={`Planner: ${plannerLabel}`}
            />
            <Icon name="arrow-right" size={10} class="commander-cell-arrow" />
          </>
        )}
        <AgentAvatar
          name={runnerName}
          label={runnerLabel}
          role="owner"
          size={20}
          title={`${runnerRole}: ${runnerLabel}`}
        />
        {task.reviewer_agent && (
          <>
            <Icon name="arrow-right" size={10} class="commander-cell-arrow" />
            <AgentAvatar
              name={task.reviewer_agent}
              label={reviewerLabel}
              role="reviewer"
              size={20}
              title={`Reviewer: ${reviewerLabel}`}
            />
          </>
        )}
      </div>
      <div
        class="commander-cell-pill"
        title={task.stage_reason || undefined}
      >
        <StageToken stage={task.running_run_id ? "running" : displayStage} />
      </div>
      <div class="commander-cell-age">{formatAge(task.updated_at)}</div>
      {isStreaming && event && (
        <div class="commander-live-line" key={`${task.id}-${event.ts || event.t || 0}`}>
          <ToolToken event={event} compact />
        </div>
      )}
    </div>
  );
}
