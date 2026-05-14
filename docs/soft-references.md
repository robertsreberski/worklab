# Soft Reference Decisions

Worklab keeps a few semantic references out of SQLite foreign-key enforcement
because the referenced rows can be historical, optional, or deleted without
invalidating the audit trail. This document records the current decision so the
absence of a `REFERENCES` clause is explicit.

| Column | Current decision | Enforcement seam | Rationale |
| --- | --- | --- | --- |
| `projects.team_id` | Soft reference for now. | Project and team route/domain helpers resolve and validate team IDs when assigning project team context. | Projects can survive team archive/removal, and old project rows should remain readable. |
| `task_runs.agent_name` | Soft reference for now. | Run creation validates enabled agents before spawn; run display joins agent rows opportunistically. | Historical runs must survive agent deletion/rename and still show the original executor string. |
| `tasks.delegated_by_run_id` | Soft reference for now. | Delegation creation writes the source run ID through watcher delegation helpers. | Delegation history should remain readable even if a run row is pruned in a future retention flow. |
| `task_edges.created_by_run_id` | Soft reference for now. | Subtask edge creation is centralized in watcher delegation helpers. | Edges describe graph provenance but should not be deleted if a creating run is pruned. |
| `assistant_messages.run_id` | Soft reference for now. | Assistant routes link messages to assistant run rows at creation and fetch linked runs opportunistically. | User-visible conversation history should survive run cleanup or failed run creation. |

If any of these columns becomes part of a strict lifecycle where deletes should
cascade or block, add a migration and a regression test before changing the
schema. Until then, new code should enforce invariants in the relevant domain
service and treat missing referenced rows as historical data, not corruption.
