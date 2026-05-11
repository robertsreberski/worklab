// §4.4 CommanderRow — the canonical dense task row.
// Dense grid:
//   checkbox · id · title+live · deps-chip · planner/owner/reviewer · status-pill · age
// Error chip policy (§5.3): derived from last_run.status === 'error'.
// "Stuck" chip: running_run_id && is_locked===false (§5.2).

import { useMemo } from "preact/hooks";
import { mergeRunEvents } from "../lib/useRunStream.js";
import { AgentLink } from "./AgentLink.jsx";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { Icon } from "./Icon.jsx";
import { statusMeta } from "./primitives/StatusPill.jsx";
import { StageToken } from "./primitives/StageToken.jsx";
import { LivePulse } from "./primitives/LivePulse.jsx";
import { normalizeToolTokenEvent, ToolToken } from "./primitives/ToolToken.jsx";
import { Checkbox } from "./primitives/Checkbox.jsx";
import { agentDisplayName, hasRunError, taskDisplayKey, taskRecoveryLabel } from "../lib/display.js";
import { hasFileEditChangesPayload, isMutationToolName, sourceToolIdForFileEditId, toolResultPayload } from "../lib/toolEventLinking.js";

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

function isThinkingPreviewEvent(event) {
  return event?.kind === "think" || event?.type === "thinking";
}

function previewThinkingText(event) {
  return event?.text || event?.content || event?.thinking || "";
}

function isTextPreviewEvent(event) {
  return event?.kind === "text" || event?.type === "text";
}

function previewText(event) {
  return event?.text || event?.content || "";
}

function mergePreviewText(current, next) {
  const left = current || "";
  const right = next || "";
  if (!right) return left;
  if (!left) return right;
  if (left === right) return left;

  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (leftTrimmed && rightTrimmed) {
    if (leftTrimmed === rightTrimmed) return left;
    if (rightTrimmed.length >= leftTrimmed.length && rightTrimmed.startsWith(leftTrimmed)) return right;
  }

  return `${left}${right}`;
}

function previewEventBlocks(event) {
  if (!event) return [];
  if (event.type === "sdk_event") return previewEventBlocks(event.event);
  const content = event.message?.content || event.content;
  if ((event.type === "assistant" || event.type === "message" || event.type === "user") && Array.isArray(content)) {
    return content;
  }
  return [event];
}

function toolUseIdFromBlock(block) {
  if (block?.type !== "tool_use") return null;
  return block.tool_use_id || block.id || null;
}

function toolResultIdFromBlock(block) {
  if (block?.type !== "tool_result") return null;
  return block.tool_use_id || null;
}

function fileEditPayloadFromBlock(block) {
  if (block?.type === "tool_use" && block.name === "file_edit") return block.input;
  if (block?.type === "tool_result") return toolResultPayload(block);
  return null;
}

export function commanderLivePreviewEvents(events = [], { limit = 2 } = {}) {
  const preview = [];
  const sourceToolsById = new Map();
  const collapsedSourceToolIds = new Set();
  const pushPreview = (event, meta = {}) => preview.push({ event, ...meta });
  const lastPreview = () => preview[preview.length - 1]?.event || null;

  for (const rawEvent of events || []) {
    for (const rawBlock of previewEventBlocks(rawEvent)) {
      const rawToolResultId = toolResultIdFromBlock(rawBlock);
      if (rawToolResultId && collapsedSourceToolIds.has(rawToolResultId)) continue;

      let event = normalizeToolTokenEvent(rawBlock);
      if (!event) continue;

      const rawToolUseId = toolUseIdFromBlock(rawBlock);
      if (rawToolUseId && isMutationToolName(event.name)) {
        sourceToolsById.set(rawToolUseId, { name: event.name });
      }

      if (event.name === "file_edit") {
        const fileEditId = rawToolUseId || rawToolResultId || event.tool_use_id || event.id;
        if (fileEditId && rawToolResultId) {
          for (let index = preview.length - 1; index >= 0; index -= 1) {
            if (preview[index].toolUseId === fileEditId) preview.splice(index, 1);
          }
        }
        const sourceToolId = sourceToolIdForFileEditId(fileEditId);
        const sourceTool = sourceToolId ? sourceToolsById.get(sourceToolId) : null;
        if (sourceTool && hasFileEditChangesPayload(fileEditPayloadFromBlock(rawBlock))) {
          collapsedSourceToolIds.add(sourceToolId);
          for (let index = preview.length - 1; index >= 0; index -= 1) {
            if (preview[index].toolUseId === sourceToolId) preview.splice(index, 1);
          }
          event = { ...event, display_name: sourceTool.name };
        }
      }

      if (isThinkingPreviewEvent(event)) {
        const text = previewThinkingText(event);
        if (!text.trim()) continue;
        const last = lastPreview();
        if (isThinkingPreviewEvent(last)) {
          last.text = mergePreviewText(previewThinkingText(last), text);
        } else {
          pushPreview({ ...event, type: "thinking", text }, { toolUseId: rawToolUseId || event.tool_use_id || event.id || null });
        }
        continue;
      }
      if (isTextPreviewEvent(event)) {
        const text = previewText(event);
        if (!text.trim()) continue;
        const last = lastPreview();
        if (isTextPreviewEvent(last)) {
          last.text = mergePreviewText(previewText(last), text);
        } else {
          pushPreview({ ...event, type: "text", text }, { toolUseId: rawToolUseId || event.tool_use_id || event.id || null });
        }
        continue;
      }
      pushPreview(event, { toolUseId: rawToolUseId || event.tool_use_id || event.id || null });
    }
  }
  return preview.slice(-limit).map((item) => item.event);
}

export function commanderRunningPreviewEvents(task, runProgressEvents = []) {
  const runningRunId = runningRunIdFromTask(task);
  if (!runningRunId) return [];
  const initial = task?.running_run?.last_event ? [task.running_run.last_event] : [];
  const progressEvents = (runProgressEvents || []).filter((event) => event);
  return commanderLivePreviewEvents(mergeRunEvents(initial, progressEvents).slice(-12), { limit: 2 });
}

export function commanderRowStagePresentation(task) {
  const displayStage = task?.stage || "plan";
  const runtimeStatus = runningRunIdFromTask(task) ? "running" : displayStage;
  return { displayStage, runtimeStatus };
}

function commanderGoalStatusLabel(task = {}) {
  if (task?.goal_contract?.paused_at) return "Goal paused";
  const status = task?.goal_status || "in_progress";
  if (status === "complete") return "Goal complete";
  if (status === "blocked") return "Goal blocked";
  return "Team goal";
}

function commanderGoalChipClass(task = {}) {
  if (task?.goal_contract?.paused_at) return "chip-muted";
  if (task?.goal_status === "blocked") return "chip-warn";
  if (task?.goal_status === "complete") return "chip-trigger";
  return "chip-accent";
}

export function CommanderRow({
  task,
  agents = [],
  selected = false,
  checked = false,
  onSelect,
  onToggleCheck,
  onOpen,
  runProgressEvents = [],
}) {
  const runningRunId = runningRunIdFromTask(task);
  const isStreaming = !!runningRunId;
  const previewEvents = useMemo(() => {
    return commanderRunningPreviewEvents(task, runProgressEvents);
  }, [runProgressEvents, task]);
  const { displayStage, runtimeStatus } = commanderRowStagePresentation(task);
  const meta = statusMeta(runtimeStatus);

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
  const recoveryLabel = taskRecoveryLabel(task);
  const pendingActions = Array.isArray(task.pending_actions) ? task.pending_actions : [];
  const blockingIssues = Array.isArray(task.blocking_issues) ? task.blocking_issues : [];
  const autoRun = task.run_policy === "auto_plan_execute";
  const schedule = task.automation_summary || {};
  const hasSchedule = Number(schedule.count || 0) > 0;
  const scheduleEnabled = Number(schedule.enabled_count || 0) > 0;
  const scheduleTitle = schedule.next_fire_at
    ? `Next scheduled run: ${new Date(schedule.next_fire_at).toLocaleString()}`
    : (hasSchedule ? "Task schedule is paused" : undefined);
  const isTeamGoalRoot = Boolean(task.is_team_root && task.team_id && task.project_id);

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
  } else if (recoveryLabel) {
    metaChip = (
      <span class="chip chip-warn">
        <Icon name="refresh-cw" size={10} /> {recoveryLabel}
      </span>
    );
  } else if (runError) {
    metaChip = (
      <span class="chip chip-error">
        <Icon name="alert-triangle" size={10} /> Error
      </span>
    );
  } else if (blockingIssues.length > 0) {
    metaChip = (
      <span class="chip chip-error" title={blockingIssues.join("\n")}>
        <Icon name="alert-triangle" size={10} /> {blockingIssues.length} blocking
      </span>
    );
  } else if (pendingActions.length > 0) {
    metaChip = (
      <span class="chip chip-warn" title={pendingActions.join("\n")}>
        <Icon name="check-circle" size={10} /> {pendingActions.length} action{pendingActions.length === 1 ? "" : "s"}
      </span>
    );
  } else if (needsOwner && blockedCount === 0) {
    metaChip = <span class="chip chip-warn">Needs owner</span>;
  }

  const depsChip = blockedCount > 0 ? (
    <span class="blocked-chip" title="Waiting for dependent tasks to finish">
      <Icon name="clock" size={10} /> Waiting on {blockedCount}
    </span>
  ) : null;

  return (
    <div
      class={`commander-row ${selected ? "selected" : ""} ${isStreaming && previewEvents.length ? "running" : ""}`}
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
            <a
              class="chip chip-muted commander-project-chip"
              href={`#/projects/${encodeURIComponent(task.project.slug || task.project.id)}`}
              title={`Project: ${task.project.name || task.project.slug}`}
              onClick={(event) => event.stopPropagation()}
            >
              <Icon name="folder" size={10} /> {task.project.name || task.project.slug}
            </a>
          )}
          {isTeamGoalRoot && (
            <a
              class={`chip ${commanderGoalChipClass(task)} team-goal-chip`}
              href={`#/goals/${encodeURIComponent(task.id)}`}
              title={task.goal_status_reason || "Synthetic team goal root"}
              onClick={(event) => event.stopPropagation()}
            >
              <Icon name="check-circle" size={10} /> {commanderGoalStatusLabel(task)}
            </a>
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
            <AgentLink
              name={task.planner_agent}
              label={plannerLabel}
              role="planner"
              agents={agents}
              showAvatar
              showLabel={false}
              size={20}
              title={`Planner: ${plannerLabel}`}
            />
            <Icon name="arrow-right" size={10} class="commander-cell-arrow" />
          </>
        )}
        {runnerName ? (
          <AgentLink
            name={runnerName}
            label={runnerLabel}
            role="owner"
            agents={agents}
            showAvatar
            showLabel={false}
            size={20}
            title={`${runnerRole}: ${runnerLabel}`}
          />
        ) : (
          <AgentAvatar
            name={runnerName}
            label={runnerLabel}
            role="owner"
            size={20}
            title={`${runnerRole}: ${runnerLabel}`}
          />
        )}
        {task.reviewer_agent && (
          <>
            <Icon name="arrow-right" size={10} class="commander-cell-arrow" />
            <AgentLink
              name={task.reviewer_agent}
              label={reviewerLabel}
              role="reviewer"
              agents={agents}
              showAvatar
              showLabel={false}
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
        <StageToken stage={displayStage} pulse={isStreaming} />
      </div>
      <div class="commander-cell-age">{formatAge(task.updated_at)}</div>
      {isStreaming && previewEvents.length > 0 && (
        <div class="commander-live-line">
          {previewEvents.map((event, index) => (
            <div class="commander-live-line-row" key={`${task.id}-${event._event_seq ?? event.id ?? event.ts ?? event.t ?? index}`}>
              <ToolToken event={event} compact />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
