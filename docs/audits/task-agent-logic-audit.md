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
- Agent runtime package: `@mono-agent/agent-runtime`
- ACP profiles and runtime resolution: `src/core/acp-profiles.js`,
  `src/core/acp-runtime-profile.js`, and `src/core/acp-controls.js`
- ACP operations and interactions: `src/coordinator/acp-operation-manager.js`,
  `src/coordinator/spawn-worker/acp-interactions.js`, and
  `src/api/routes/acp.js`

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

## External ACP Agents

An ACP-backed agent is stored as `sdk = 'acp'`, model
`acp:<profile-id>`, and execution mode `acp`. The coordinator preflights that
binding before spawn. The worker resolves the profile through the shared
runtime and receives permission or elicitation responses over its private
stdin control channel. A task worker sends an exact browser continuation URL
to the coordinator over a dedicated inherited pipe rather than stdout or
stderr; a management operation carries it through a non-enumerable in-process
handoff. The coordinator retains either form only in its bounded, owner-bound,
one-use memory store. Operation and task-run interaction schemas are sanitized
before persistence or broadcast; response values and exact continuation URLs
are process-only data and must never enter SQLite, run events, logs, or backups.

Generic profiles are client-owned but limited to the services Worklab actually
implements. Filesystem, terminal, and client-MCP requests are rejected during
profile validation. Mono profiles come from a sanitized discovery descriptor;
their command, environment-key set, configuration, workspace, MCP ownership,
session policy, and probe timeout are agent-owned and immutable in Worklab.
Both discovery and runtime processes receive an explicit environment allowlist.

Agent-owned turns use `src/core/acp-task-input.js`. They receive task-owned
state, comments, saved plans, prior outcomes, review evidence, workspace/result
contracts, and file `resource_link` attachments. They do not receive Worklab
persona instructions, memory, knowledge, skills, tools, MCP configuration,
repository instructions, webhooks, resume payloads, or delegation policy.
Because ACP has no native output-schema request field, the result contract in
that task-owned handoff includes the canonical stage-scoped `worklab.v2` JSON
Schema and a valid skeleton before Worklab applies strict result validation.

ACP runtime updates arrive as raw protocol events followed by normalized
companions. The coordinator keeps every sanitized event in the explicit raw
log, but persists and streams only stable, bounded display upserts: a cumulative
answer, a safe status/reasoning activity row with no private thought text, and
one named lifecycle row per tool id. Companions carry an internal marker so even
an orphaned full-history event remains hidden. Legacy display tails keep raw
updates and companions atomic and cap long streams.

ACP provider session identifiers are opaque runtime values. Worklab may store
and return the encoded identifier, but must not persist the remote raw session
id or let one profile delete another profile's session. Cancellation is
semantic: task aborts reach `session/cancel`, pending interactions settle
fail-closed, and late protocol updates remain bounded and typed.

Profile controls are asynchronous operations. One operation may be active for
a profile at a time. The profile's bounded timeout applies while a control is
starting or running, pauses for an explicit user interaction, and is rearmed
when the operation resumes. Cancellation aborts the runtime request and gives
its handler a bounded cleanup interval. During coordinator startup, queued,
running, and interaction-waiting operations left by the previous process are
atomically failed as `coordinator_restarted`; unresolved interactions for
terminal operations are expired so profiles do not remain permanently busy.

Generic ACP profiles launch a canonical absolute executable directly, without
a shell, and project only the values of explicitly named host environment
variables. Their persisted client capability policy must keep filesystem,
terminal, network, and client-MCP services disabled. Those flags describe
services Worklab will provide over ACP; they do not sandbox the child process
from resources available to the Worklab OS user. ACP bindings currently accept
task runs only. A task without a project workdir adopts the canonical
agent-owned workspace. An explicit project workdir must resolve to that same
canonical workspace, and agent-owned workspaces cannot be paired with a
Worklab-created run worktree.

## Team Lead Cycles

Team leads run as `task_runs.kind = 'lead_cycle'` against synthetic team-root
tasks. They return `worklab.lead_cycle.v1`, and the watcher converts the result
into normal Worklab side effects: creating tasks, adding advisory comments,
recording goal status, and applying goal refinements. Lead cycles do not
directly mutate arbitrary task state.

Lead cycles may be event-driven, scheduled, or manual. Only one in-flight lead
cycle should exist for the same team/project workstream at a time.

## Boundary Rules

Runtime-provider code belongs in the shared `@mono-agent/agent-runtime`
package and must not depend on Worklab DB, API, coordinator, or UI modules.
Worklab domain behavior belongs in `src/core`. API, CLI, MCP, coordinator, and
UI layers should consume core through public seams or documented query helpers.

SQL belongs in `src/core/db/queries/` or schema/migration files. API routes must
not use `db.prepare()` directly.

All state-changing `/api` routes and active reads that can start a process use
the API mutation boundary. Browser calls need an accepted `Origin`/`Referer`;
non-browser automation needs the local service bearer token.
`WORKLAB_ACP_ALLOWED_ORIGINS` adds exact HTTP(S) browser origins for trusted
proxy layouts. This boundary mitigates cross-site request triggering but is not
network authentication: listener exposure and tailnet membership remain an
operator-owned trust decision.

## Audit Checklist

When changing task or agent behavior, verify the relevant checks:

- `npm run lint`
- `npm run lint:size`
- `./scripts/guard-imports.sh`
- Focused Vitest files for the touched core/coordinator/worker/API/UI seams
- `npm test` before broad workflow handoff
- `npm run build:ui` when UI routes, shared UI modules, or served assets change
- `git diff --check`
