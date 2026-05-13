// Worktree tools available inside an agent run. These let the active run check
// and reconcile its isolated AI worktree with current source checkout truth
// before the agent emits its final Worklab result.

import { z } from "zod";
import { inspectRunWorktree, syncRunWorktreeFromSource } from "../../../core/index.js";
import { safeParse, withDb } from "./shared.js";

export const worktreeSyncSchema = z.object({
  action: z.enum(["status", "merge_source"]).default("status"),
});

export const definitions = [
  {
    name: "worktree_sync",
    description:
      "Inspect or merge current source checkout truth into this run's isolated AI worktree. Use action='merge_source' after committing and before final output in worktree mode.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "merge_source"],
          description: "status is read-only. merge_source merges current source HEAD into only this run's AI worktree.",
        },
      },
      required: ["action"],
    },
  },
];

function publicWorktreeResult(result, { runId, action, workspaceMode }) {
  return {
    ok: !!result?.ok,
    status: result?.status || "unknown",
    run_id: runId,
    action,
    workspace_mode: workspaceMode || null,
    branch: result?.metadata?.branch || null,
    source_workdir: result?.metadata?.source_workdir || null,
    worktree_root: result?.metadata?.worktree_root || null,
    source_head: result?.source_head || null,
    branch_head: result?.branch_head || null,
    previous_branch_head: result?.previous_branch_head || null,
    base_head: result?.base_head || result?.metadata?.base_head || null,
    source_drift: !!result?.source_drift,
    source_changed_paths: result?.source_changed_paths || [],
    worktree_changed_paths: result?.worktree_changed_paths || [],
    overlap_paths: result?.overlap_paths || [],
    dirty_paths: result?.dirty_paths || [],
    source_dirty_paths: result?.source_dirty_paths || [],
    worktree_dirty_paths: result?.worktree_dirty_paths || [],
    conflict_paths: result?.conflict_paths || [],
    synced_at: result?.synced_at || null,
  };
}

export function buildHandlers(context) {
  const { dataDir, runId } = context;
  return {
    async worktree_sync(input) {
      const { action } = worktreeSyncSchema.parse(input || {});
      if (!runId) throw new Error("run_id is required for worktree_sync");

      return await withDb(dataDir, (db) => {
        const row = db.prepare(`
          SELECT id, workspace_mode, worktree_json
          FROM task_runs
          WHERE id = ?
        `).get(runId);
        if (!row) throw new Error(`run not found: ${runId}`);
        if ((row.workspace_mode || "direct") !== "worktree") {
          return {
            ok: false,
            status: "not_worktree",
            run_id: runId,
            action,
            workspace_mode: row.workspace_mode || "direct",
          };
        }

        const metadata = safeParse(row.worktree_json || "null");
        const result = action === "merge_source"
          ? syncRunWorktreeFromSource({ metadata })
          : inspectRunWorktree({ metadata });

        if (action === "merge_source" && result?.metadata) {
          db.prepare("UPDATE task_runs SET worktree_json = ? WHERE id = ?")
            .run(JSON.stringify(result.metadata), runId);
        }

        return publicWorktreeResult(result, {
          runId,
          action,
          workspaceMode: row.workspace_mode || "worktree",
        });
      });
    },
  };
}
