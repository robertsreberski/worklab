// Stale-running reconcile + drained-resume detection. Both run at watcher
// boot time, immediately after the migrations, so any task_runs row left in
// `running` state by the previous coordinator gets a sensible terminal state
// before we start spawning fresh workers.
//
// reconcileStaleRunningRuns: pure stale path. The previous coordinator died
// without finalising the row (no SIGTERM, no drain, no clean cancel). The
// only safe action is to mark the run abandoned and reset the task to its
// retry stage.
//
// findDrainedResumeCandidates: R5 graceful-drain path. The previous
// coordinator did finalise the row — it sent a `worklab_drain` over the IPC
// pipe, the worker emitted a tagged transcript_tail snapshot, and the run
// row is `cancelled_shutdown`. We surface those rows so the watcher can
// schedule a fresh `coordinator_resume` continuation that picks up the
// snapshot rather than starting from scratch.

import { buildTranscriptTailSnapshot } from "@mono-agent/agent-runtime/agent/transcript.js";
import { readJsonlEventsFromFile } from "../../core/index.js";
import { expireUnresolvedAcpInteractionsForTerminalRuns } from "../../core/db/queries/acp-interactions.js";

function unwrapSdkEvent(event) {
  return event?.type === "sdk_event" && event.event ? event.event : event;
}

function drainedShutdownEvent(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "drained") continue;
    if (!event.reason || event.reason === "coordinator_shutdown") return event;
  }
  return null;
}

function recoverDrainedSnapshot(row, { dataDir, logger } = {}) {
  if (!row?.raw_output_path || !dataDir) return null;
  let events = [];
  try {
    events = readJsonlEventsFromFile(row.raw_output_path, { dataDir });
  } catch (err) {
    logger?.warn?.({ err: err.message, runId: row.id }, "failed to inspect stale run raw log");
    return null;
  }
  const drained = drainedShutdownEvent(events);
  if (!drained) return null;
  const snapshot = buildTranscriptTailSnapshot(events.map(unwrapSdkEvent));
  if (!snapshot) {
    return { drained, transcriptTailJson: null };
  }
  return {
    drained,
    transcriptTailJson: JSON.stringify({
      ...snapshot,
      resume_kind: "drained",
      drain_acknowledged: true,
      recovered_from_raw_log: true,
    }),
  };
}

export function reconcileStaleRunningRuns(db, logger, { dataDir = null } = {}) {
  const now = Date.now();
  const reconcile = db.transaction(() => {
    const stale = db.prepare(
      `SELECT id, task_id, stage, raw_output_path FROM task_runs
       WHERE process_status = 'running' OR status = 'running'`,
    ).all();
    const markAbandonedRun = db.prepare(
      `UPDATE task_runs
       SET process_status = 'abandoned', status = 'error', ended_at = ?,
           failure_kind = 'abandoned', error_text = ?,
           cancel_initiator = COALESCE(cancel_initiator, 'stale_reconcile'),
           cancel_reason = COALESCE(cancel_reason, 'coordinator restarted while run was active')
       WHERE id = ?`,
    );
    const markDrainedRun = db.prepare(
      `UPDATE task_runs
       SET process_status = 'cancelled', status = 'cancelled', ended_at = ?,
           failure_kind = 'cancelled_shutdown',
           error_text = COALESCE(error_text, ?),
           cancel_initiator = COALESCE(cancel_initiator, 'coordinator_shutdown'),
           cancel_reason = COALESCE(cancel_reason, 'coordinator stopped while run was draining'),
           transcript_tail_json = COALESCE(transcript_tail_json, ?)
       WHERE id = ?`,
    );
    const markTask = db.prepare(
      `UPDATE tasks
       SET stage = CASE WHEN stage = 'done' THEN stage ELSE COALESCE(?, stage, 'plan') END,
           error_text = COALESCE(error_text, ?),
           stage_reason = COALESCE(stage_reason, ?),
           updated_at = ?
       WHERE id = ?`,
    );
    let abandoned = 0;
    let recoveredDrained = 0;
    for (const row of stale) {
      const retryStage = row.stage || "plan";
      const drained = recoverDrainedSnapshot(row, { dataDir, logger });
      if (drained) {
        markDrainedRun.run(
          now,
          "coordinator stopped before finalizing drained run",
          drained.transcriptTailJson,
          row.id,
        );
        markTask.run(retryStage, "Previous run stopped during coordinator shutdown", "coordinator_shutdown", now, row.task_id);
        recoveredDrained += 1;
      } else {
        markAbandonedRun.run(now, "coordinator restarted", row.id);
        markTask.run(retryStage, "Previous run did not finish", "abandoned", now, row.task_id);
        abandoned += 1;
      }
    }
    const expiredInteractions = expireUnresolvedAcpInteractionsForTerminalRuns(db, {
      disposition: "run_ended",
      resolvedAt: now,
    }).changes;
    return { abandoned, recoveredDrained, expiredInteractions };
  });
  const counts = reconcile();
  const count = counts.abandoned + counts.recoveredDrained;
  if (count > 0) {
    logger?.warn?.(
      {
        count,
        abandoned: counts.abandoned,
        recovered_drained: counts.recoveredDrained,
        expired_interactions: counts.expiredInteractions,
      },
      "reconciled stale running runs at boot",
    );
  } else if (counts.expiredInteractions > 0) {
    logger?.warn?.(
      { expired_interactions: counts.expiredInteractions },
      "expired unresolved ACP interactions for terminal runs at boot",
    );
  }
  return count;
}

// Drained-resume detection. Selects task_runs rows that:
//   - were finalised as `cancelled_shutdown` by the previous coordinator,
//   - carry a transcript_tail_json blob tagged `resume_kind: "drained"`,
//   - and have no continuation row pointing at them yet (so we don't
//     re-resume the same drain twice across coordinator restarts).
// Returns lightweight row descriptors; the watcher consumes these and calls
// spawnRun with `continuation_reason: "coordinator_resume"`.
export function findDrainedResumeCandidates(db) {
  const rows = db.prepare(`
    SELECT id, task_id, stage, mode, agent_name, transcript_tail_json
    FROM task_runs
    WHERE failure_kind = 'cancelled_shutdown'
      AND transcript_tail_json IS NOT NULL
      AND json_valid(transcript_tail_json)
      AND json_extract(transcript_tail_json, '$.resume_kind') = 'drained'
      AND NOT EXISTS (
        SELECT 1 FROM task_runs child
        WHERE child.parent_run_id = task_runs.id
           OR (child.diagnostics_json IS NOT NULL
               AND json_valid(child.diagnostics_json)
               AND json_extract(child.diagnostics_json, '$.continuation_of_run_id') = task_runs.id)
      )
    ORDER BY started_at ASC, rowid ASC
  `).all();
  return rows.map((row) => {
    let snapshot = null;
    try {
      snapshot = JSON.parse(row.transcript_tail_json);
    } catch {
      snapshot = null;
    }
    return {
      runId: row.id,
      taskId: row.task_id,
      stage: row.stage,
      mode: row.mode,
      agentName: row.agent_name,
      snapshot,
    };
  });
}
