# Worklab Task And Agent Logic Audit

Date: 2026-04-25

Status: code-derived audit. Earlier docs were treated as obsolete during this review.

## Executive Summary

Worklab currently has a useful local orchestration base: agents, tasks,
runs, comments, SSE streaming, SDK dispatch, MCP tools, schedules, KB,
journals, memory consolidation, and provider registry are all present.
The task and agent workflow logic is not yet coherent enough for
"bulletproof" autonomous cooperation.

The core problem is that task state and process state are mixed together.
`in_progress` currently means "worker running", "executor failed and needs
retry", "reviewer rejected changes", "human manually moved it", and
"maybe stuck". That ambiguity creates retry dead ends, unclear UI actions,
and fragile recovery paths. The system also has no first-class concept of
subtasks, delegated subagents, parent/child joins, or autonomous task
planning.

The target direction should be a v2 workflow, not incremental patching for
backward compatibility:

- Tasks are delegated to an owning agent.
- The owning agent can plan autonomously.
- The owning agent can create subtasks and delegate them to other configured
  agents.
- Parent tasks wait for required child tasks, then resume with child
  summaries and artifacts.
- All SDK and CLI runtimes return the same structured `worklab_result`.
- All transitions are centralized, transactional, recoverable, and visible.

## Sources Reviewed

Local Worklab code:

- `src/core/state-machine.js`
- `src/coordinator/task-watcher.js`
- `src/coordinator/spawn-worker.js`
- `src/worker.js`
- `src/core/ai.js`
- `src/core/ai-claude.js`
- `src/core/ai-openai.js`
- `src/core/ai-vercel.js`
- `src/core/ai-tool-helpers.js`
- `src/api/routes-tasks.js`
- `src/api/routes-agents.js`
- `src/api/routes-schedules.js`
- `src/core/schema.js`
- `src/core/db.js`
- `src/mcp/worklab-tools.js`
- `src/ui/src/routes/TaskDetail.jsx`
- `src/ui/src/routes/Commander.jsx`
- `src/ui/src/routes/TaskEdit.jsx`

Reference implementation:

- `../../services/forge-ai`
- Especially `src/core/scheduler.ts`, `src/core/state.ts`,
  `src/core/contracts.ts`, `src/core/finalization.ts`,
  `src/core/diagnostics.ts`, `src/core/management.ts`,
  `src/providers/claude-code.ts`, and `src/providers/codex.ts`.

Local CLI capability check:

- Claude Code: `2.1.120`
- Codex CLI: `0.125.0`
- Claude supports non-interactive stream JSON and JSON schema output:
  `claude -p --output-format stream-json --json-schema ...`.
- Codex supports non-interactive JSONL and output schema:
  `codex exec --json --output-schema ...`.

Verification baseline:

- `npm test -- --reporter=dot`
- Result: 52 test files passed, 467 tests passed.

Passing tests do not mean the workflow is correct. Several important defects
are hidden by test stubs that bypass the real worker exit behavior.

## Current System Shape

### Task Model

Persisted task statuses:

- `todo`
- `in_progress`
- `in_review`
- `done`

Related tables:

- `tasks`
- `task_runs`
- `agent_logs`
- `task_comments`
- `task_dependencies`
- `schedules`
- `schedule_spawns`

There is no task hierarchy. Dependencies are blockers only; they do not
represent parent/child delegation, ownership, subtasks, or join semantics.

### Run Model

Runs are rows in `task_runs` with:

- `mode`: `execute`, `review`, or `consolidate`
- `status`: `running`, `complete`, `error`, or `cancelled`
- `worker_pid`
- timing and exit metadata

Events are persisted as JSON in `agent_logs.events` after the worker exits.
Live events are broadcast over SSE while the worker is running.

### Agent Model

Agents store:

- model reference
- SDK value
- effort
- instructions
- skill allowlist
- MCP allowlist
- built-in tool allowlist
- enabled flag

The `sdk` column is mostly derived from `model`. Actual dispatch is based on
`parseModelReference(model)`, not on `agent.sdk`.

Supported runtime paths:

- Claude Agent SDK
- OpenAI Agents SDK
- Vercel AI SDK for custom/local OpenAI-compatible providers

Claude Code and Codex CLI were not first-class agent providers at the time of
this audit; the implementation now exposes them through local CLI model refs.

## Findings

### 1. `in_progress` Is Overloaded

`in_progress` currently means too many things:

- an executor worker is actively running
- an executor worker failed
- a reviewer rejected the work
- a human manually moved the task there
- the UI should show it under Todo
- the UI may show it as Blocked if the last run failed
- the task may be stuck if no active worker exists

This is the largest workflow design flaw. It prevents clean retry semantics
and makes UI state derived from a mixture of task status, run status, active
map state, dependencies, and error text.

Best practice: task workflow stage and run process status must be separate.

### 2. Rejected And Failed Tasks Can Become Retry Dead Ends

`nextStatus("in_review", { type: "review_rejected" })` returns
`in_progress`.

`nextStatus("in_progress", { type: "run_failed" })` stays
`in_progress`.

But `createTaskWatcher.handleRunRequested` rejects any task that is not
exactly `todo`:

```js
if (task.status !== "todo") {
  throw new Error(`task already ${task.status}`);
}
```

The TaskDetail primary Run button is also only shown for `todo`. A rejected
or failed task can therefore be visibly in a "needs more work" state while
lacking a direct run path.

Target fix: failed or rejected work should move to a retryable workflow stage
such as `execute`, not to a process-like `in_progress` state. The run endpoint
should dispatch by stage eligibility, not by "todo only".

### 3. Real Review Parse Failures Do Not Follow The Documented Path

In `worker.js`, review mode emits `final`, then emits `verdict`, then exits:

- exit `0` for APPROVE/REJECT
- exit `2` for missing verdict

`spawn-worker.js` marks any non-zero exit as `error`. Therefore a missing
verdict from the real worker reaches `handleReviewExit` as `res.status ===
"error"` and goes through the generic "Review failed" branch.

The special parse-failure branch in `handleReviewExit` only runs when tests
stub a complete result with no verdict. The real worker does not behave that
way.

Target fix: never encode semantic review outcome in process exit code.
Process exit should indicate runtime success/failure. The agent's decision
must be structured data in the result contract.

### 4. Manual Status Moves Bypass Runtime Semantics

The API allows human moves into `in_progress` through `human_move`. This does
not spawn a worker. A task can be marked "in progress" without any active run.

Target fix: manual transitions should operate on workflow stages. "Run now"
should be a command that creates a run. Manual stage moves should never imply
a worker is active.

### 5. Cancel Handling Is Not Unified

Current behavior differs by path:

- Active execute cancel posts "Run cancelled" and leaves status unchanged.
- Active review cancel posts "Review cancelled" and leaves status unchanged.
- Stale cancel marks run error and resets `in_progress` tasks to `todo`.
- Boot reconciliation marks running runs as error and resets `in_progress` to
  `todo`.

This produces inconsistent recovery and user messaging.

Target fix: cancellation should be a first-class transition with a policy:

- cancel by user -> `blocked` or previous retryable stage with
  `failure_kind = user_cancelled`
- stale/abandoned worker -> `blocked` or retryable stage with
  `failure_kind = abandoned`
- review cancel -> parent stage remains reviewable with explicit retry action

### 6. `task.description` Is Dead

Schema v5 removed `tasks.description`, but `buildTaskBody` still checks
`task.description`. Some tests still build fake task objects with
description.

This is harmless at runtime, but it is dead code and stale mental model.

Target fix: remove `description` references or intentionally reintroduce a
single body field. Prefer one `instructions` or `body` field for task content.

### 7. `retry_count` Exists But Is Unused

`tasks.retry_count` exists in schema and serialization, but retry logic is not
implemented through it. Runtime history is more accurately derivable from
`task_runs`.

Target fix: drop `retry_count` or replace it with derived runtime counters
based on run history:

- failure count
- failure streak
- rejection count
- rejection streak
- latest attempt

### 8. Worker Finalization Can Race Late Stdout

`spawn-worker.js` finalizes on child `exit`. If stdout still has buffered
data, especially a final event, it may not be read before DB finalization.
Forge explicitly guards this with close/exit finalization and stream cleanup.

Target fix: finalize on `close`, with an exit grace fallback. Finalization
must be one-shot.

### 9. OpenAI/Vercel Built-In Tool CWD Is Inconsistent

Built-in tools use `process.env.WORKLAB_WORKSPACE || process.cwd()`.

The worker is spawned with:

- `WORKLAB_RUN_ID`
- `WORKLAB_DATA_DIR`
- `WORKLAB_REPO_ROOT`

It does not set `WORKLAB_WORKSPACE`. Claude SDK receives `cwd` directly, but
OpenAI/Vercel built-in tools may run relative to the repo process cwd rather
than `config.workspace`.

Target fix: set `WORKLAB_WORKSPACE` in every worker process env and in every
CLI provider env.

### 10. Active Deletion Paths Are Risky

Deleting a task cascades `task_runs`. If a worker exits after the cascade,
`spawn-worker.js` still tries to update the run and insert `agent_logs`.
That can fail with FK issues or leave the worker promise rejected in an
unclear state.

Deleting an agent during an active run can also interfere with final comment
authoring and future run attribution.

Target fix:

- Do not delete running tasks or agents.
- Or implement cancellation plus tombstone semantics.
- Prefer soft delete or archived state for entities with run history.

### 11. MCP Failures Are Too Quiet

OpenAI and Vercel MCP setup paths use `Promise.allSettled` and silently skip
failed servers. That is acceptable for optional tools only if surfaced as a
run warning event. Right now the user may not know an agent lacked expected
tools.

Target fix: failed MCP server initialization should emit normalized
`runtime_warning` events and be stored in run metadata.

### 12. Schedule Semantics Are Incomplete

Schedules create tasks. They do not clearly define whether spawned tasks
should auto-run, how duplicate due ticks are prevented under partial failure,
or how schedule errors are surfaced.

Target fix:

- Schedule spawn should be transactional.
- Schedule policy should explicitly choose `create_only` or `create_and_run`.
- Each schedule trigger should create a run-source/audit record.

### 13. There Is No First-Class Delegation Or Subtask Model

This is the biggest missing product capability relative to the desired app
idea.

Current dependencies can express "task B waits for task A", but they cannot
express:

- parent task owns child subtasks
- an agent delegated a child task to a subagent
- parent waits for child completion
- parent consumes child result summaries
- child is optional vs required
- child failure policy
- child artifacts
- parallel vs sequential subtask execution
- subagent autonomy within a parent plan

Target fix: add task hierarchy and delegation contracts.

## Best Practices To Follow

### State And Runtime

- Model workflow stage separately from run process status.
- Make each transition explicit and reducer-driven.
- Persist every transition with an audit event.
- Use DB transactions for state changes plus side effects that write DB rows.
- Broadcast SSE only after commit.
- Treat worker process death as recoverable state, not exceptional mystery.

### Agent Cooperation

- Give one agent ownership of the parent task.
- Let the owner plan autonomously.
- Let the owner delegate bounded subtasks to configured agents.
- Prevent agents from mutating task state directly.
- Use structured task-management tools or structured result requests.
- Use no-self-review where review independence matters.
- Preserve child artifacts separately from parent synthesis.
- Summarize child results into parent context instead of dumping all logs.

### Provider Runtime

- Hide SDK/CLI differences behind provider adapters.
- Validate provider availability before dispatch.
- Normalize streaming events across providers.
- Require a structured final result for every successful run.
- Classify failures by kind: validation, spawn, timeout, stall, usage limit,
  invalid result, tool failure, cancelled, abandoned.
- Keep CLI stdout/stderr raw output as artifacts for debug.

### Recovery

- Every nonterminal failure should have a next action.
- Retryable states must have a visible Retry command.
- User-action states must show exact pending actions.
- Stale processes must be detected at startup and by a health check.
- Repeated failure loops should route to `blocked` with a reason.
- Usage limits should pause dispatch instead of consuming retries.

## Recommended V2 Data Model

### Tasks

Replace the current flat task status with workflow stage fields:

- `id`
- `root_task_id`
- `parent_task_id`
- `delegated_by_run_id`
- `delegated_to_agent`
- `owner_agent`
- `title`
- `body` or `instructions`
- `stage`
- `stage_reason`
- `join_policy`
- `subtask_order`
- `required`
- `created_at`
- `updated_at`
- `completed_at`

Recommended stages:

- `draft`: human-created or agent-created task not yet planned
- `plan`: parent/owner agent planning
- `execute`: implementation/research/work stage
- `review`: plan or work review
- `verify`: code/work verification
- `qa`: final validation
- `awaiting_user`: paused for explicit human action
- `blocked`: cannot continue without manual intervention
- `done`: accepted terminal state

This can be simplified for v1.5 if needed, but do not keep `in_progress` as
both process and workflow state.

### Runs

Run process status:

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`
- `abandoned`

Run fields:

- `id`
- `task_id`
- `parent_run_id`
- `stage`
- `agent_name`
- `provider_kind`
- `process_status`
- `decision`
- `failure_kind`
- `retry_stage`
- `started_at`
- `ended_at`
- `worker_pid`
- `exit_code`
- `summary`
- `details`
- `raw_output_path`
- `artifact_paths_json`

### Delegation

Either add a dedicated `task_edges` table or extend `task_dependencies`.
Preferred: a new table.

Fields:

- `parent_task_id`
- `child_task_id`
- `edge_type`: `subtask`, `depends_on`, `follow_up`
- `required`
- `created_by_run_id`
- `created_at`

This keeps blockers separate from ownership and allows a child task to have
normal dependency edges.

## Structured Result Contract

All runtimes should return this shape on successful process completion:

```json
{
  "schema": "worklab.v2",
  "stage": "execute",
  "decision": "advance",
  "summary": "Short outcome.",
  "details": "Optional details.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "subtasks": []
}
```

Allowed decisions:

- `advance`: stage work completed, move forward
- `approve`: review/qa approved, move forward
- `reject`: reviewer rejected, route back to work
- `block`: agent cannot proceed; move to blocked
- `pause`: needs explicit human action; move to awaiting_user
- `delegate`: create subtasks and wait or continue according to policy

Subtask item:

```json
{
  "title": "Investigate provider adapter shape",
  "instructions": "Read the existing SDK dispatch and propose a CLI adapter boundary.",
  "suggested_agent": "architect",
  "required": true,
  "depends_on": [],
  "acceptance_criteria": [
    "Names files to change",
    "Identifies CLI-specific failure modes"
  ],
  "expected_artifact": "adapter_plan_markdown"
}
```

The coordinator validates every subtask. Agents request delegation; they do
not directly edit task rows.

## Ideal Workflow

### Human Starts A Task

1. Human creates a root task and assigns an owner agent.
2. Coordinator validates owner provider and task dependencies.
3. Coordinator creates a run for the owner agent in `plan` or `execute`.
4. Worker streams normalized events.
5. Worker returns `worklab_result`.

### Owner Agent Delegates

1. Owner returns `decision: "delegate"` with `subtasks`.
2. Coordinator creates child tasks with `parent_task_id` and
   `delegated_by_run_id`.
3. Coordinator assigns each child to the requested or selected eligible agent.
4. Parent enters `awaiting_children`.
5. Independent children run in parallel up to concurrency limits.
6. Dependent children run after their blockers are done.
7. Child failures route to retry, blocked, or awaiting_user by policy.
8. When required children are done, coordinator summarizes child outputs.
9. Parent agent resumes with child summaries and artifact references.
10. Parent synthesizes final result and routes through review/verify/qa.

### Review And QA

1. Review agents must be independent where possible.
2. Review uses child summaries and artifacts, not only parent final text.
3. Reject routes to the relevant task:
   - parent rejection -> parent execute
   - child rejection -> child execute
   - cross-cutting rejection -> parent creates targeted child subtasks
4. Repeated rejection routes to `blocked`.

### Human Pause

1. Agent returns `decision: "pause"` with exact `pending_actions`.
2. Task moves to `awaiting_user`.
3. UI shows commands/actions and risk text.
4. Human approves or denies.
5. Approval resumes the original stage.
6. Denial moves to `blocked` or returns to planning.

## CLI Provider Plan

### Claude Code

Use:

```bash
claude -p --output-format stream-json --verbose --json-schema <schema> ...
```

Relevant options:

- `--model`
- `--effort`
- `--permission-mode plan|bypassPermissions`
- `--allowedTools`
- `--disallowedTools`
- `--mcp-config`
- `--append-system-prompt`
- `--no-session-persistence`
- `--cwd` equivalent via process cwd

Adapter responsibilities:

- generate command args
- stream JSON events
- parse tool use and result events
- parse final structured result
- classify usage limits and max token truncation
- record cost when available

### Codex CLI

Use:

```bash
codex exec --json --output-schema <schema> ...
```

Relevant options:

- `--model`
- `--sandbox read-only|workspace-write|danger-full-access`
- `--full-auto`
- `--dangerously-bypass-approvals-and-sandbox`
- `--cd`
- `--add-dir`
- `--ephemeral`
- `--config model_reasoning_effort=...`

Adapter responsibilities:

- generate command args
- map Worklab permission modes to Codex sandbox modes
- stream JSONL events
- parse final structured result
- estimate cost from usage events when present
- classify auth/model/provider failures

## UX Requirements

Task detail must show:

- task tree
- parent and root task
- owner agent
- delegated children
- child status and agent
- running child count
- blocked child count
- parent waiting reason
- retry actions
- pending human actions
- final synthesis

Commander must group by workflow stage, not by inferred mixtures of task
status, active worker, dependencies, and last run.

Every nonterminal task must answer:

- What is happening?
- Which agent owns it?
- Is any process running?
- What is blocking it?
- What can the user do now?

## Error Recovery Matrix

| Case | Target behavior |
| --- | --- |
| Provider missing key | Do not dispatch; show provider validation issue |
| CLI not installed | Do not dispatch; show install/config issue |
| Spawn failure | Mark run failed, task retryable or blocked by retry policy |
| Timeout | Kill process, preserve raw output, mark retryable |
| Stall | Kill process, mark `failure_kind = stall`, retryable |
| Usage/rate limit | Pause dispatch until reset; do not count as task failure |
| Invalid result JSON | Mark invalid_result, retry with guidance |
| Missing decision | Mark invalid_result, retry with contract guidance |
| Review reject | Route task back to appropriate work stage |
| Repeated reject | Move to blocked with reject-limit reason |
| User cancel | Cancel process, move to blocked or retryable stage with reason |
| Coordinator restart | Mark orphaned running runs abandoned and expose retry |
| Task deleted while running | Disallow delete or cancel first |
| Agent deleted while running | Disallow delete or disable after active runs finish |
| Child task blocked | Parent waits and shows blocked child |
| Required child failed repeatedly | Parent moves to blocked with child failure summary |
| Optional child failed | Parent may continue with warning |

## Implementation Phases For Later Build Plan

### Phase 1: Stabilize Existing Workflow

- Split process status from task workflow status.
- Fix retry dead ends.
- Fix review parse failure behavior.
- Fix worker finalization on `close`.
- Set `WORKLAB_WORKSPACE` in worker env.
- Block deletion of running tasks/agents.
- Add unified cancellation and stale run recovery.

### Phase 2: Structured Result Contract

- Add `worklab_result` schema and parser.
- Update SDK prompts to require structured results.
- Stop using process exit code for semantic reviewer outcome.
- Normalize run events and failure kinds.

### Phase 3: CLI Providers

- Add provider adapter abstraction.
- Implement Claude Code provider.
- Implement Codex provider.
- Add provider validation and stream parsing tests.

### Phase 4: Subtasks And Delegation

- Add task hierarchy schema.
- Add delegation result handling.
- Add task-tree UI.
- Add parent wait/resume mechanics.
- Add child summary/artifact injection.

### Phase 5: Review/QA Cooperation

- Add no-self-review rules.
- Add review assignment policy.
- Add reject-limit and failure-limit policies.
- Add parent/child failure propagation.

### Phase 6: Diagnostics And Repair

- Add run diagnostics API.
- Add stale lease/process doctor.
- Add anomaly detection similar to Forge:
  stale running run, lease without run, provider validation, review stall,
  dangling dependency, rejected-loop, blocked child.

## Tests Required

Regression tests:

- Failed executor task remains retryable from UI/API.
- Rejected review task remains retryable from UI/API.
- Review missing structured result is invalid_result, not generic crash.
- Manual stage move cannot fake a running worker.
- Cancel behavior is consistent for execute/review/child/parent tasks.
- Worker final event is persisted even when stdout closes after exit.
- Worker env includes `WORKLAB_WORKSPACE`.
- Deleting running task is rejected.
- Deleting active agent is rejected.

Delegation tests:

- Parent creates one required child and waits.
- Parent creates parallel children and resumes after all required children.
- Child dependencies enforce order.
- Optional child failure does not block parent unless policy says so.
- Required child repeated failure blocks parent.
- Parent cancellation handles children by explicit policy.
- Child result summary is available to parent resume prompt.
- Agent-created child task cannot reference nonexistent agent silently.
- Agent-created child task cannot create dependency cycles.

Provider tests:

- Claude Code command generation.
- Claude Code stream parsing.
- Claude Code structured result parsing.
- Codex command generation.
- Codex JSONL parsing.
- Codex structured result parsing.
- Usage-limit classification for both CLI providers.
- Provider validation prevents dispatch and surfaces warnings.

UI tests:

- Task tree renders parent and children.
- Waiting parent shows child progress.
- Blocked child is visible from parent.
- Retry action appears for retryable stages.
- Awaiting user action displays exact pending action.

## Decisions

- Do not preserve backward compatibility for obsolete task statuses or docs.
- Do not copy Forge's filesystem board model. Worklab should remain DB and UI
  native.
- Do copy Forge's resilience patterns: provider adapters, contracts,
  process health checks, leases/active records, failure classification,
  diagnostics, repair, pause/resume, and explicit stage decisions.
- Treat configured Worklab agents as subagents. A subagent may use any
  supported SDK or CLI provider.
- Parent agents have autonomy to delegate unless they explicitly pause for
  human input or policy blocks delegation.
