import { normalizeLeadTaskTitle } from "../../core/worklab-result/lead-cycle-contract.js";
import { taskStage } from "../../core/task-side-effects.js";
import {
  appendTeamGoalCheckpoint,
  applyTeamGoalRefinement,
  effectiveTeamForTask,
  ensureTeamRootTask,
  hasInFlightLeadCycle,
  leadCycleBlockedByGoal,
} from "../../core/teams.js";
import {
  consumeLeadCycleFollowup,
  listDueLeadCycleFollowups,
  listMatchingLeadCycleEventFollowups,
  recordLeadCycleCompleted,
  recordLeadCycleFailed,
  recordLeadCycleStarted,
} from "../../core/goals.js";
import { enabledAgentExists } from "../../core/db/queries/agents.js";
import { getTaskById } from "../../core/db/queries/tasks.js";
import { getTeamById, getTeamRosterAgentNames } from "../../core/db/queries/teams.js";
import { checkBudget } from "./budget.js";
import { runProcessStatus, safeParseJson } from "./run-handler.js";

export function createLeadCycleCoordinator({
  db,
  broker,
  logger,
  active,
  pendingStarts,
  leadCycleFollowupIntervalMs,
  spawnRun,
  postSystemComment,
  patchRunDiagnostics,
  maybeAutoStartTask,
  validateDelegationRequest,
  createDelegatedSubtasks,
  maybeRunDelegatedChildren,
  autoRunPolicy = "auto_plan_execute",
}) {
  const pendingLeadCycleRequests = new Map();
  let leadCycleFollowupTimer = null;

  function leadCycleRequestKey(teamId, projectId) {
    return `${teamId || ""}::${projectId || ""}`;
  }

  function queueLeadCycleRequest({ teamId, projectId, reason }) {
    if (!teamId || !projectId) return;
    pendingLeadCycleRequests.set(leadCycleRequestKey(teamId, projectId), reason || "task_unassigned");
  }

  function drainQueuedLeadCycleRequest({ teamId, projectId }) {
    if (!teamId || !projectId) return;
    const key = leadCycleRequestKey(teamId, projectId);
    const reason = pendingLeadCycleRequests.get(key);
    if (!reason) return;
    pendingLeadCycleRequests.delete(key);
    setTimeout(() => {
      const out = spawnLeadCycleRunInternal({ teamId, projectId, reason });
      if (!out.ok && out.skipped === "in_flight") {
        queueLeadCycleRequest({ teamId, projectId, reason });
      } else if (!out.ok) {
        logger?.warn?.({ teamId, projectId, reason, err: out.error }, "queued lead cycle skipped");
      }
    }, 0);
  }

  function spawnLeadCycleRunInternal({ teamId, projectId, reason = "manual" } = {}) {
    if (!teamId || !projectId) return { ok: false, error: "teamId and projectId required" };
    if (hasInFlightLeadCycle(db, { teamId, projectId })) {
      return { ok: false, error: "lead cycle already in flight", skipped: "in_flight" };
    }
    const team = getTeamById(db, teamId);
    if (!team) return { ok: false, error: "team not found" };
    if (!team.lead_agent) return { ok: false, error: "team has no lead_agent" };
    if (team.status !== "active") return { ok: false, error: "team is archived" };
    const root = ensureTeamRootTask(db, { teamId, projectId, now: Date.now() });
    if (!root) return { ok: false, error: "could not resolve synthetic root task" };
    const goalBlock = leadCycleBlockedByGoal(db, { teamId, projectId, reason });
    if (goalBlock) return { ok: false, ...goalBlock };
    if (active.has(root.id)) return { ok: false, error: "lead cycle already running on this root" };
    const budget = checkBudget({ db, agentName: team.lead_agent, teamId });
    if (!budget.ok) return { ok: false, error: budget.message, scope: budget.scope };
    try {
      const startedAt = Date.now();
      const handle = spawnRun({
        task: root,
        stage: "execute",
        mode: "execute",
        agentName: team.lead_agent,
        kind: "lead_cycle",
        teamId,
        diagnosticsSeed: { lead_cycle_reason: reason, lead_cycle_team_id: teamId, lead_cycle_project_id: projectId },
      });
      try {
        recordLeadCycleStarted(db, {
          goalId: root.id,
          runId: handle.runId,
          taskId: root.id,
          teamId,
          projectId,
          reason,
          startedAt,
        });
      } catch (err) {
        logger?.warn?.({ err: err.message, runId: handle.runId }, "lead cycle timeline start write failed");
      }
      try {
        db.prepare("UPDATE teams SET last_lead_cycle_at = ? WHERE id = ?").run(startedAt, teamId);
      } catch (err) {
        logger?.warn?.({ err: err.message }, "team last_lead_cycle_at update failed");
      }
      broker?.broadcast?.("global", {
        type: "lead_cycle_started",
        team_id: teamId,
        project_id: projectId,
        run_id: handle.runId,
        reason,
      });
      return { ok: true, runId: handle.runId, taskId: root.id };
    } catch (err) {
      logger?.warn?.({ err: err.message, teamId, projectId }, "lead cycle spawn failed");
      return { ok: false, error: err.message };
    }
  }

  function maybeScheduleLeadCycle(taskId, taskStageValue) {
    try {
      const task = getTaskById(db, taskId);
      if (!task || task.is_team_root) return;
      const teamId = effectiveTeamForTask(db, task);
      if (!teamId) return;
      const projectId = task.project_id;
      if (!projectId) return;
      const reason = taskStageValue === "blocked" ? "task_blocked" : "task_completed";
      consumeMatchingLeadCycleEventHints({ teamId, projectId, event: reason });
      spawnLeadCycleRunInternal({ teamId, projectId, reason });
    } catch (err) {
      logger?.warn?.({ err: err.message, taskId }, "maybeScheduleLeadCycle failed");
    }
  }

  function maybeScheduleUnassignedTeamTask(taskId, reason = "task_unassigned") {
    try {
      const task = getTaskById(db, taskId);
      if (!task || task.is_team_root) return { ok: false, skipped: "not_applicable" };
      if (String(task.owner_agent || "").trim()) return { ok: false, skipped: "already_owned" };
      const stage = taskStage(task);
      if (stage === "done" || stage === "blocked") return { ok: false, skipped: "terminal" };
      const teamId = effectiveTeamForTask(db, task);
      if (!teamId) return { ok: false, skipped: "no_team" };
      const projectId = task.project_id || null;
      if (!projectId) return { ok: false, skipped: "no_project" };
      const out = spawnLeadCycleRunInternal({ teamId, projectId, reason });
      if (!out.ok && out.skipped === "in_flight") {
        queueLeadCycleRequest({ teamId, projectId, reason });
      }
      return out;
    } catch (err) {
      logger?.warn?.({ err: err.message, taskId }, "maybeScheduleUnassignedTeamTask failed");
      return { ok: false, error: err.message };
    }
  }

  function consumeMatchingLeadCycleEventHints({ teamId, projectId, event, now = Date.now() } = {}) {
    const matches = listMatchingLeadCycleEventFollowups(db, { teamId, projectId, event, limit: 20 });
    for (const cycle of matches) {
      consumeLeadCycleFollowup(db, cycle.id, now);
    }
    return matches.length;
  }

  function tickLeadCycleFollowups(now = Date.now()) {
    const due = listDueLeadCycleFollowups(db, { now, limit: 20 });
    let started = 0;
    let skipped = 0;
    for (const cycle of due) {
      consumeLeadCycleFollowup(db, cycle.id, now);
      const out = spawnLeadCycleRunInternal({
        teamId: cycle.team_id,
        projectId: cycle.project_id,
        reason: "review_due",
      });
      if (out?.ok) started += 1;
      else skipped += 1;
      if (!out?.ok && out?.skipped === "in_flight") {
        queueLeadCycleRequest({
          teamId: cycle.team_id,
          projectId: cycle.project_id,
          reason: "review_due",
        });
      } else if (!out?.ok) {
        logger?.warn?.(
          { teamId: cycle.team_id, projectId: cycle.project_id, cycleId: cycle.id, err: out?.error },
          "due lead cycle follow-up skipped",
        );
      }
    }
    return { checked: due.length, started, skipped };
  }

  function applyLeadCycleAssignments({ taskId, teamId, projectId, finalLead }) {
    const assignments = Array.isArray(finalLead?.task_assignments) ? finalLead.task_assignments : [];
    if (!assignments.length || !teamId || !projectId) return 0;

    const roster = new Set(getTeamRosterAgentNames(db, teamId));
    const now = Date.now();
    const skipped = [];
    let assigned = 0;

    for (const assignment of assignments) {
      const targetId = String(assignment?.target_task_id || "").trim();
      const ownerAgent = String(assignment?.owner_agent || "").trim();
      const rationale = String(assignment?.rationale || "").trim();
      if (!targetId || !ownerAgent) continue;
      const target = getTaskById(db, targetId);
      if (!target) {
        skipped.push(`${targetId}: task not found`);
        continue;
      }
      if (target.is_team_root) {
        skipped.push(`${targetId}: team root cannot be assigned`);
        continue;
      }
      if ((target.project_id || null) !== projectId) {
        skipped.push(`${targetId}: outside lead-cycle project`);
        continue;
      }
      if (effectiveTeamForTask(db, target) !== teamId) {
        skipped.push(`${targetId}: outside team scope`);
        continue;
      }
      if (String(target.owner_agent || "").trim()) {
        skipped.push(`${targetId}: already has an owner`);
        continue;
      }
      const targetStage = taskStage(target);
      if (targetStage === "done" || targetStage === "blocked") {
        skipped.push(`${targetId}: terminal task`);
        continue;
      }
      if (!roster.has(ownerAgent)) {
        skipped.push(`${targetId}: ${ownerAgent} is not in the team roster`);
        continue;
      }
      if (!enabledAgentExists(db, ownerAgent)) {
        skipped.push(`${targetId}: ${ownerAgent} is not enabled`);
        continue;
      }

      const result = db.prepare(`
        UPDATE tasks
        SET owner_agent = ?, updated_at = ?
        WHERE id = ?
          AND COALESCE(owner_agent, '') = ''
          AND COALESCE(stage, 'plan') NOT IN ('done', 'blocked')
      `).run(ownerAgent, now, targetId);
      if (!result.changes) {
        skipped.push(`${targetId}: no longer assignable`);
        continue;
      }
      postSystemComment(
        targetId,
        `Team lead assigned owner ${ownerAgent}.${rationale ? ` Rationale: ${rationale}` : ""}`,
      );
      broker?.broadcast?.("global", { type: "task_updated", id: targetId, taskKey: target.task_key || null });
      maybeAutoStartTask(targetId);
      assigned += 1;
    }

    if (skipped.length) {
      postSystemComment(taskId, `Lead cycle task_assignments skipped:\n- ${skipped.join("\n- ")}`);
    }
    return assigned;
  }

  function leadCycleExistingTitleIndex({ taskId, teamId, projectId }) {
    if (!projectId) return new Set();
    const rows = db.prepare(`
      SELECT title
      FROM tasks
      WHERE project_id = ?
        AND COALESCE(is_team_root, 0) = 0
        AND (? IS NULL OR team_id = ? OR team_id IS NULL)
        AND id <> ?
    `).all(projectId, teamId || null, teamId || null, taskId);
    return new Set(rows.map((row) => normalizeLeadTaskTitle(row.title)).filter(Boolean));
  }

  function filterDuplicateLeadCreations({ taskId, teamId, projectId, creations }) {
    const existingTitles = leadCycleExistingTitleIndex({ taskId, teamId, projectId });
    const accepted = [];
    const skipped = [];
    for (const item of creations || []) {
      const title = String(item?.title || "").trim();
      if (!title) continue;
      const normalized = normalizeLeadTaskTitle(title);
      if (normalized && existingTitles.has(normalized)) {
        skipped.push({ title, reason: "duplicates existing task in this team/project" });
        continue;
      }
      if (normalized) existingTitles.add(normalized);
      accepted.push(item);
    }
    return { accepted, skipped };
  }

  function taskHasActiveRun(taskId) {
    if (active.has(taskId) || pendingStarts.has(taskId)) return true;
    const rows = db.prepare(`
      SELECT process_status, status, ended_at
      FROM task_runs
      WHERE task_id = ?
    `).all(taskId);
    return rows.some((row) => {
      const processStatus = String(row.process_status || row.status || "running");
      const status = String(row.status || row.process_status || "running");
      return processStatus === "queued"
        || processStatus === "running"
        || (row.ended_at == null && (status === "queued" || status === "running"));
    });
  }

  function applyLeadCycleDeletions({ taskId, teamId, projectId, finalLead }) {
    const deletions = Array.isArray(finalLead?.task_deletions) ? finalLead.task_deletions : [];
    if (!deletions.length) return { count: 0, tombstones: [] };

    const skipped = [];
    const tombstones = [];
    const seen = new Set();

    for (const deletion of deletions) {
      const targetId = String(deletion?.target_task_id || "").trim();
      const rationale = String(deletion?.rationale || "").trim();
      if (!targetId || seen.has(targetId)) continue;
      seen.add(targetId);

      const target = getTaskById(db, targetId);
      if (!target) {
        skipped.push(`${targetId}: task not found`);
        continue;
      }
      if (target.id === taskId || target.is_team_root) {
        skipped.push(`${target.task_key || target.id}: team root cannot be deleted`);
        continue;
      }
      if ((target.project_id || null) !== projectId) {
        skipped.push(`${target.task_key || target.id}: outside lead-cycle project`);
        continue;
      }
      if (teamId && effectiveTeamForTask(db, target) !== teamId) {
        skipped.push(`${target.task_key || target.id}: outside team scope`);
        continue;
      }
      const edge = db.prepare(`
        SELECT e.created_by_run_id, r.kind AS creator_kind, r.task_id AS creator_task_id,
               r.team_id AS creator_team_id, r.project_id AS creator_project_id
        FROM task_edges e
        LEFT JOIN task_runs r ON r.id = e.created_by_run_id
        WHERE e.parent_task_id = ?
          AND e.child_task_id = ?
          AND e.edge_type = 'subtask'
        LIMIT 1
      `).get(taskId, targetId);
      if (!edge || edge.creator_kind !== "lead_cycle" || edge.creator_task_id !== taskId
        || (teamId && edge.creator_team_id !== teamId)
        || (projectId && edge.creator_project_id !== projectId)) {
        skipped.push(`${target.task_key || target.id}: not lead-cycle-created for this goal`);
        continue;
      }
      if (taskStage(target) === "done") {
        skipped.push(`${target.task_key || target.id}: already done`);
        continue;
      }
      if (taskHasActiveRun(targetId)) {
        skipped.push(`${target.task_key || target.id}: has active run`);
        continue;
      }
      const childCount = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM task_edges
        WHERE parent_task_id = ?
          AND edge_type = 'subtask'
      `).get(targetId)?.count || 0);
      if (childCount > 0) {
        skipped.push(`${target.task_key || target.id}: has child subtasks`);
        continue;
      }

      tombstones.push({
        target_task_id: target.id,
        task_key: target.task_key || null,
        title: target.title || "",
        owner_agent: target.owner_agent || null,
        stage: taskStage(target),
        rationale,
      });
    }

    if (tombstones.length) {
      const tx = db.transaction(() => {
        for (const tombstone of tombstones) {
          db.prepare("DELETE FROM tasks WHERE id = ?").run(tombstone.target_task_id);
        }
      });
      tx();
      const lines = tombstones.map((item) => {
        const ref = item.task_key || item.target_task_id;
        return `- ${ref}: ${item.title}${item.rationale ? ` - ${item.rationale}` : ""}`;
      });
      postSystemComment(taskId, `Lead cycle deleted ${tombstones.length} lead-created task${tombstones.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
      for (const tombstone of tombstones) {
        broker?.broadcast?.("global", {
          type: "task_deleted",
          id: tombstone.target_task_id,
          taskKey: tombstone.task_key || null,
        });
      }
      broker?.broadcast?.("global", { type: "task_updated", id: taskId });
    }

    if (skipped.length) {
      postSystemComment(taskId, `Lead cycle task_deletions skipped:\n- ${skipped.join("\n- ")}`);
    }
    return { count: tombstones.length, tombstones };
  }

  function handleLeadCycleExit(taskId, runId, res, task, run) {
    const processStatus = runProcessStatus(res);
    const teamId = run.team_id || (task ? effectiveTeamForTask(db, task) : null);
    const projectId = run.project_id || task?.project_id || null;
    const finalLead = res?.leadCycleResult || (() => {
      try { return safeParseJson(run.result_json, null); } catch { return null; }
    })();

    db.prepare(
      `UPDATE task_runs SET decision = COALESCE(decision, 'lead_cycle'), summary = COALESCE(summary, ?), details = COALESCE(details, ?) WHERE id = ?`,
    ).run(finalLead?.summary || res.summary || null, finalLead?.goal_status_reason || null, runId);

    if (res?.diagnostics && typeof res.diagnostics === "object" && !Array.isArray(res.diagnostics)) {
      patchRunDiagnostics(runId, res.diagnostics);
    }

    if (processStatus !== "succeeded" || !finalLead || finalLead.schema !== "worklab.lead_cycle.v1") {
      const failureKind = res.failureKind || res.failure_kind || (processStatus === "cancelled" ? "cancelled" : "lead_cycle_invalid_result");
      db.prepare(
        `UPDATE task_runs SET failure_kind = COALESCE(failure_kind, ?), retry_stage = COALESCE(retry_stage, 'execute') WHERE id = ?`,
      ).run(failureKind, runId);
      try {
        recordLeadCycleFailed(db, {
          runId,
          processStatus,
          status: res?.status || run?.status || "error",
          failureKind,
          errorText: res?.error || run?.error_text || null,
          costUsd: res?.costUsd ?? res?.cost_usd ?? run?.cost_usd ?? null,
          endedAt: Date.now(),
        });
      } catch (err) {
        logger?.warn?.({ err: err.message, runId }, "lead cycle timeline failure write failed");
      }
      postSystemComment(taskId, `Lead cycle did not produce a valid worklab.lead_cycle.v1 result (${failureKind}).`);
      broker?.broadcast?.("global", {
        type: "lead_cycle_failed",
        team_id: teamId,
        project_id: projectId,
        run_id: runId,
        failure_kind: failureKind,
      });
      drainQueuedLeadCycleRequest({ teamId, projectId });
      return;
    }

    const now = Date.now();
    const goalRefinementApplied = applyTeamGoalRefinement(db, {
      teamId,
      projectId,
      rootTaskId: taskId,
      runId,
      refinement: finalLead.goal_refinement || null,
      now,
    });
    if (goalRefinementApplied?.applied) {
      const fields = goalRefinementApplied.applied_fields?.length
        ? goalRefinementApplied.applied_fields.join(", ")
        : "goal contract";
      postSystemComment(taskId, [
        `Lead cycle refined goal: ${fields}.`,
        goalRefinementApplied.rationale ? `Rationale: ${goalRefinementApplied.rationale}` : "",
        Object.keys(goalRefinementApplied.patch_applied || {}).length
          ? `Applied patch: ${JSON.stringify(goalRefinementApplied.patch_applied)}`
          : "",
      ].filter(Boolean).join("\n"));
      broker?.broadcast?.("global", {
        type: "team_goal_updated",
        team_id: teamId,
        project_id: projectId,
        run_id: runId,
      });
    } else if (
      finalLead.goal_refinement?.mode === "apply"
      && Array.isArray(goalRefinementApplied?.skipped)
      && goalRefinementApplied.skipped.length
    ) {
      const lines = goalRefinementApplied.skipped.map((item) => {
        const field = String(item?.field || "goal_refinement").trim();
        const reason = String(item?.reason || "not applied").trim();
        return `${field}: ${reason}`;
      });
      postSystemComment(taskId, `Lead cycle goal refinement skipped:\n- ${lines.join("\n- ")}`);
    }

    const deletionResult = applyLeadCycleDeletions({ taskId, teamId, projectId, finalLead });
    const tasksAssigned = applyLeadCycleAssignments({ taskId, teamId, projectId, finalLead });
    let tasksCreated = 0;
    let notesPosted = 0;

    const rawCreations = Array.isArray(finalLead.task_creations) ? finalLead.task_creations : [];
    const { accepted: creations, skipped: skippedCreations } = filterDuplicateLeadCreations({
      taskId,
      teamId,
      projectId,
      creations: rawCreations,
    });
    if (skippedCreations.length) {
      const lines = skippedCreations.map((item) => `${item.title}: ${item.reason}`);
      postSystemComment(taskId, `Lead cycle task_creations skipped:\n- ${lines.join("\n- ")}`);
    }
    if (creations.length) {
      const subtasks = creations.map((item) => ({
        title: String(item?.title || "").trim(),
        instructions: String(item?.instructions || ""),
        suggested_agent: String(item?.suggested_agent || "").trim() || null,
        depends_on: Array.isArray(item?.depends_on) ? item.depends_on : [],
        acceptance_criteria: Array.isArray(item?.acceptance_criteria) ? item.acceptance_criteria : [],
        expected_artifact: item?.expected_artifact || null,
        required: true,
      })).filter((item) => item.title);
      try {
        const validated = validateDelegationRequest(task, subtasks);
        if (!validated.ok) {
          postSystemComment(taskId, `Lead cycle task_creations rejected: ${validated.error}`);
        } else {
          const children = createDelegatedSubtasks(task, runId, validated.subtasks, {
            parentResult: { summary: finalLead.summary, details: finalLead.goal_status_reason || "" },
            replaceExistingEdges: false,
            childTeamId: teamId,
            childRunPolicy: autoRunPolicy,
            childTags: ["delegated", "lead-cycle"],
          });
          tasksCreated = children.length;
          maybeRunDelegatedChildren(taskId, children, { force: true });
        }
      } catch (err) {
        logger?.warn?.({ err: err.message, runId }, "lead-cycle delegation failed");
        postSystemComment(taskId, `Lead cycle delegation failed: ${err.message}`);
      }
    }

    const notes = Array.isArray(finalLead.advisory_notes) ? finalLead.advisory_notes : [];
    for (const note of notes) {
      const target = String(note?.target_task_id || "").trim();
      if (!target) continue;
      const targetRow = getTaskById(db, target);
      if (!targetRow) continue;
      const targetTeam = effectiveTeamForTask(db, targetRow);
      if (teamId && targetTeam !== teamId) continue;
      const prefix = note.kind === "blocker_observation" ? "Lead cycle blocker observation"
        : note.kind === "warning" ? "Lead cycle warning"
        : "Lead cycle suggestion";
      postSystemComment(target, `${prefix}: ${String(note.content || "").trim()}`);
      notesPosted += 1;
    }

    const goalStatus = finalLead.goal_status;
    const goalReason = String(finalLead.goal_status_reason || "").trim() || null;
    db.prepare(
      `UPDATE tasks SET goal_status = ?, goal_status_reason = ?, last_lead_at = ?, updated_at = ? WHERE id = ?`,
    ).run(goalStatus, goalReason, now, now, taskId);
    appendTeamGoalCheckpoint(db, {
      rootTaskId: taskId,
      runId,
      goalStatus,
      checkpointNote: finalLead.checkpoint_note || finalLead.summary || "",
      validationSummary: finalLead.validation_summary || "",
      now,
    });
    try {
      recordLeadCycleCompleted(db, {
        runId,
        result: { ...finalLead, task_deletions: deletionResult.tombstones },
        processStatus,
        status: res?.status || run?.status || "complete",
        costUsd: res?.costUsd ?? res?.cost_usd ?? run?.cost_usd ?? null,
        tasksCreated,
        tasksAssigned,
        tasksDeleted: deletionResult.count,
        taskCreationSkips: skippedCreations,
        tasksSkipped: skippedCreations.length,
        goalRefinementApplied,
        notesPosted,
        endedAt: now,
      });
    } catch (err) {
      logger?.warn?.({ err: err.message, runId }, "lead cycle timeline completion write failed");
    }
    if (teamId) {
      try {
        db.prepare("UPDATE teams SET last_lead_cycle_at = ? WHERE id = ?").run(now, teamId);
      } catch (err) {
        logger?.warn?.({ err: err.message, teamId }, "team last_lead_cycle_at write failed");
      }
    }

    if (goalStatus === "complete") {
      postSystemComment(taskId, `Team lead marked goal complete: ${goalReason || finalLead.summary}`);
      broker?.broadcast?.("global", {
        type: "team_goal_completed",
        team_id: teamId,
        project_id: projectId,
        run_id: runId,
      });
    }

    broker?.broadcast?.("global", {
      type: "lead_cycle_completed",
      team_id: teamId,
      project_id: projectId,
      run_id: runId,
      goal_status: goalStatus,
      tasks_created: tasksCreated,
      tasks_assigned: tasksAssigned,
      tasks_deleted: deletionResult.count,
    });
    drainQueuedLeadCycleRequest({ teamId, projectId });
  }

  if (Number(leadCycleFollowupIntervalMs) > 0) {
    leadCycleFollowupTimer = setInterval(() => {
      try {
        tickLeadCycleFollowups(Date.now());
      } catch (err) {
        logger?.warn?.({ err: err.message }, "lead cycle follow-up tick failed");
      }
    }, Number(leadCycleFollowupIntervalMs));
    leadCycleFollowupTimer.unref?.();
  }

  function shutdown() {
    if (leadCycleFollowupTimer) {
      clearInterval(leadCycleFollowupTimer);
      leadCycleFollowupTimer = null;
    }
  }

  return {
    handleLeadCycleExit,
    maybeScheduleLeadCycle,
    maybeScheduleUnassignedTeamTask,
    shutdown,
    spawnLeadCycleRunInternal,
    tickLeadCycleFollowups,
  };
}
