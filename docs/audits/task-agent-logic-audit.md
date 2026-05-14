# Task And Agent Logic Audit

This is the current code-derived reference for Worklab task and agent behavior.
It exists to prevent deleted historical planning docs from becoming hidden
requirements again. When this document conflicts with source or tests, update
the document from source; do not reintroduce legacy behavior.

## Source Of Truth

- Workflow transitions: `src/core/state-machine.js`
- Result contract: `src/core/worklab-result/contract.js`
- Stage and decision vocabulary: `src/core/worklab-result/decisions.js`
- Lead-cycle contract: `src/core/worklab-result/lead-cycle-contract.js`
- Coordinator scheduling: `src/coordinator/task-watcher.js` and
  `src/coordinator/watcher/`
- Worker entry points: `src/worker.js` and `src/worker/`
- Agent runtime package: `packages/agent-runtime/`

## Current Workflow Model

Tasks carry user-facing workflow stage separately from run process state.
`tasks.stage` describes where the work is in the product workflow:
`plan`, `execute`, `review`, `done`, `blocked`, or `cancelled`. Run rows carry
process status and provider/runtime diagnostics. Do not use task stage as a
proxy for whether a child process is currently alive.

Agents return structured `worklab.v2` results. The state machine accepts
workflow decisions from that contract and emits side effects for the watcher to
apply, such as spawning workers, clearing pending user-facing arrays, posting
review comments, resetting counters, or marking completion. Agents must request
task and subtask changes through controlled APIs or MCP tools rather than
direct DB or file mutation.

Review approval is gated by verification evidence when tasks have artifacts.
The gate mode may warn or block, but the invariant is that claimed verification
must correspond to real run-log evidence before a review is treated as
trustworthy.

## Run And Recovery Semantics

Worker runs are child processes. The coordinator owns scheduling, stale-run
recovery, continuation creation, cancellation handling, and shutdown draining.
Provider failure, invalid result, stale worker, cancellation, and reviewer
rejection paths must surface explicit failure kinds and user-facing state
instead of silently looping.

Recovery continuations are categorized by reason, including provider retry,
schema correction, finalization, and coordinator resume. `parent_run_id` is
disambiguated by relationship metadata so stage progression, manual retry, and
recovery continuation are not treated as the same behavior.

## Team Lead Cycles

Team leads run as `task_runs.kind = 'lead_cycle'` against synthetic team-root
tasks. They return `worklab.lead_cycle.v1`, and the watcher converts the result
into normal Worklab side effects: creating tasks, adding advisory comments,
recording goal status, and applying goal refinements. Lead cycles do not
directly mutate arbitrary task state.

Lead cycles may be event-driven, scheduled, or manual. Only one in-flight lead
cycle should exist for the same team/project workstream at a time.

## Boundary Rules

Runtime-provider code belongs in `packages/agent-runtime` and must not depend on
Worklab DB, API, coordinator, or UI modules. Worklab domain behavior belongs in
`src/core`. API, CLI, MCP, coordinator, and UI layers should consume core
through public seams or documented query helpers.

SQL belongs in `src/core/db/queries/` or schema/migration files. API routes must
not use `db.prepare()` directly.

## Audit Checklist

When changing task or agent behavior, verify the relevant checks:

- `npm run lint`
- `npm run lint:size`
- `./scripts/guard-imports.sh`
- Focused Vitest files for the touched core/coordinator/worker/API/UI seams
- `npm test` before broad workflow handoff
- `npm run build:ui` when UI routes, shared UI modules, or served assets change
- `git diff --check`
