# Implementation Plan — `automattic-benchmark-reset` Runtime Audit

> **Branch:** `runtime-audit-implementation`
> **Source audit:** `docs/audits/automattic-benchmark-reset-runtime-audit.md`
> **Mode:** autonomous, end-to-end. No human checkpoints between phases.
> **Scope:** every R# (R1–R12) and A# (A1–A4) recommendation from the audit.

## Operating contract for the executing agent

These rules hold for every phase below.

1. **Discipline** — read the relevant source files **first**, then write tests, then implementation. Don't trust file paths from the audit verbatim — verify with `ls`/`grep` against current `main`. Audit was written 2026-05-02; structure may have drifted.
2. **Tests are the gate.** A phase is *not* complete until: `npm test` is green, `./scripts/guard-imports.sh` passes, `npm run lint` passes, and (for UI changes) `npm run build:ui` + `./scripts/guard-banned-tokens.sh` pass. Coverage threshold (60%) must hold.
3. **Commit cadence.** One conventional commit per logical step inside a phase (typically: schema migration, types, core logic, wiring, tests, docs). No mega-commits. Each commit message references the recommendation ID (e.g., `feat(harness): cap playwright screenshot payloads (R1)`).
4. **No DB writes against `~/.worklab/worklab.db`.** All schema work goes through new migrations in `src/core/db/migrations/<n>-<slug>.js` and is tested against temp DBs (`WORKLAB_DATA_DIR` set to a tmp dir).
5. **Module boundaries.** Respect the layering enforced by `eslint.config.js`. New SQL goes in `src/core/db/queries/*`. Edge layers consume via `src/core/index.js`.
6. **No new audits/docs/READMEs unless this plan says so.** Update existing docs in place when behaviour changes.
7. **When in doubt about a design choice, prefer the simpler / more conservative option** — surface uncertainty as a `TODO(audit-followup)` comment, not a guess. The audit's open questions (§10) are the ones we already know we don't know.
8. **Phase exit checklist** at the bottom of each phase must be ticked off before moving on.

## Phase 0 — Branch hygiene & shared scaffolding (≈ 0.5 day)

**Goal.** Make sure the working tree is clean, baseline tests pass before any change, and a couple of small shared utilities the later phases need are in place.

### Steps

1. Confirm branch: `git branch --show-current` → `runtime-audit-implementation`. If not, branch from `main`.
2. Run `npm install` and `npm test` on a clean checkout. Record the pass/fail snapshot. Any pre-existing failures get an Issue and are *not* fixed in this plan.
3. Add a single shared module `src/agent/tool-bloat.js` (empty stub for now, only exporting types and constants — `MAX_TOOL_RESULT_BYTES`, `BINARY_BLOAT_TOOLS`, default config). Phase 1 fills it in.
4. Add a single shared util `src/ai/result/lenient-parse.js` (empty stub — `parseWorklabResultLenient(text)` returns `null`). Phase 2 fills it in.
5. Add a migration ledger entry `src/core/db/migrations/<next-version>-runtime-audit-baseline.js` that bumps `SCHEMA_VERSION` by zero (sanity check the migration runner picks up the file). Wire `current.js` accordingly. This validates the migration plumbing without changing any tables.

### Phase 0 exit checklist

- [ ] `npm test` green on baseline.
- [ ] `npm run lint` green on baseline.
- [ ] Two stub files compile and are exported via `src/agent/index.js` / `src/ai/result/index.js` (or wherever those barrels live).
- [ ] Migration runner survives a no-op migration (`npx vitest run src/__tests__/core/db/`).
- [ ] Commits land as: `chore(audit): scaffold runtime-audit implementation branch`.

---

## Phase 1 — Tool-result bloat containment (R1 + A2) — Blocking

**Goal.** Cap any single tool result at `MAX_TOOL_RESULT_BYTES` (default 256 KB) at the harness layer. Persist the original payload to disk under the run's directory. Substitute a compact text reference in the tool_result the model sees. Special-case the known offenders (`mcp__playwright__browser_take_screenshot`, `mcp__playwright__browser_snapshot`).

**Why first.** The audit shows 28 % of runs trip `context_bloat`. Single tool results up to 1.44 MB. This affects every phase that follows because the `Phase 7` smoke project will re-run agents and we want the bloat fix in place for that.

### Files

Verify and then modify:

- `src/agent/tool-bloat.js` — new module: `summarisePayload(toolName, contentBlocks, runDir)` returns `{rewrittenBlocks, savedPaths, originalBytes, truncated}`.
- `src/agent/tools/pi-bridge.js` — call `summarisePayload` on every `tool_result` before forwarding to the provider; emit a `tool_payload_truncated` warning when truncated.
- `src/agent/tools/index.js` — same wrapping for the local built-in tools (Read, Bash, etc.) that can also bloat (`Bash` >32 KB output is observed in the audit).
- `src/agent/compaction.js` — add a global per-event ceiling so the compaction logic doesn't re-inflate truncated payloads when it builds the resume snapshot.
- `src/ai/result/contract.js` — add a new diagnostics field `tool_results_truncated: number` and reflect in the Zod-or-equivalent shape.
- `src/coordinator/watcher/run-handler.js` — surface the new diagnostics in the `task_runs.diagnostics_json` blob so we can audit truncation later.
- `src/agent/transcript.js` — when building the transcript_tail, skip restoring the original (large) tool_result — point at the on-disk path instead.

### Tests

- `src/__tests__/agent/tool-bloat.test.js` — unit tests: payload under limit passes through; payload at limit is preserved; payload over limit is replaced with `{kind: "tool_result_truncated", saved_to: "<path>", original_bytes: <n>, tool: "<name>"}`. Specific case for image content blocks (base64) — must save as binary, not as text.
- `src/__tests__/agent/pi-bridge.test.js` — integration test: a fake provider streaming a 2 MB tool_result results in a truncated payload going *to the model* but the original being on disk under `~/.worklab/runs/<run_id>/tool-output/` (or whatever the canonical path is — verify against `src/core/run-logs.js`).
- `src/__tests__/agent/compaction.test.js` — compaction round-trip preserves truncation markers; resume snapshot doesn't re-expand.
- `src/__tests__/agent/transcript.test.js` — transcript_tail doesn't include the original large payload bytes.

Cite as fixture inspiration: the actual transcript_tail of run `cFIGsugNVSwEjLwdQhWFB` (1.44 MB single tool_result) — synthesise a test fixture matching that shape.

### Agent-config (A2)

- `data-template/agents/benchmark-qa-reviewer/system_prompt.md` (verify path; if it lives under `~/.worklab/agents/` only and not in `data-template/`, document that with a `TODO(audit-followup)`): add a "Tool selection guidance" section directing the agent to **prefer `mcp__playwright__browser_snapshot` (DOM) over `browser_take_screenshot` (image)** unless pixel evidence is required.
- `data-template/agents/benchmark-qa-reviewer/mcp.json` (or equivalent): if the Playwright MCP can be configured to write screenshots to disk and return paths, set that flag. Otherwise, document the limitation in the agent's prompt.

### Settings

Add a new settings key `agent.tool_payload_max_bytes` (default 262144 = 256 KB) with override in `~/.worklab/settings.json`. Plumb through `src/core/settings.js` (or wherever the canonical settings reader lives — verify in `src/core/`).

### Phase 1 exit checklist

- [ ] Replaying a synthesised "qa-reviewer mobile QA" run through the harness produces a `task_runs.diagnostics_json.tool_results_truncated >= 1`.
- [ ] On-disk payload exists at the expected path with full original bytes.
- [ ] Resume snapshot doesn't include the truncated bytes.
- [ ] All baseline tests green.
- [ ] Commits: `feat(agent): cap tool-result payloads (R1)`, `feat(agent): persist truncated payloads to run dir (R1)`, `chore(agents): prefer browser_snapshot for qa-reviewer (A2)`.

---

## Phase 2 — `invalid_result` recovery (R3 + A1) — High

**Goal.** Two-layer fix:
- **Layer 1 (lenient parse, R3a):** when the worker is about to fail a run with `invalid_result`, run the final text through `parseWorklabResultLenient` first. Strip code fences, extract the largest balanced JSON object, validate. Most `final text is not JSON` failures we observed are markdown-wrapped JSON.
- **Layer 2 (schema-correction continuation, R3b):** when even the lenient parse fails, schedule a continuation with `diagnostics.continuation_reason = "schema_correction"`, system prompt prefix instructing the agent to emit JSON only, parent_run_id chain.

### Files

- `src/ai/result/lenient-parse.js` — fill in: strip ```` ```json ... ``` ```` fences, find first balanced `{...}`, parse, validate against the existing schema.
- `src/ai/result/contract.js` — wire `parseWorklabResultLenient` as a fallback after the strict parse. New diagnostics field `result_recovered_via: "strict" | "lenient" | null`.
- `src/worker.js` — call the lenient parse before emitting `invalid_result`. If lenient succeeds, treat as success; record the fallback in diagnostics.
- `src/worker/result-emitter.js` — surface the recovery in the worklab_result envelope so the watcher knows.
- `src/coordinator/watcher/failure-classifier.js` — `invalid_result` is now classified as `retryable: true` with `continuation_reason: "schema_correction"`. Use the same continuation_limit as `provider_unavailable`.
- `src/coordinator/watcher/run-handler.js` — when scheduling a `schema_correction` continuation, prepend a system message: *"Your previous run produced text that wasn't valid worklab.v2 JSON. Re-emit your conclusion as a single JSON envelope only — no markdown fences, no commentary."* Cap retries at 2 (lower than provider recovery; if the agent can't emit JSON twice in a row, escalate).
- `src/agent/transcript.js` — when restoring a `schema_correction` continuation, include the failed run's final text as context so the agent sees what it emitted.

### Tests

- `src/__tests__/ai/result/lenient-parse.test.js` — fixtures including: bare JSON, fenced JSON, JSON with leading/trailing markdown, JSON inside a `### VERDICT` heading (matching the actual failed reviewer outputs from `01i6FI78ATSpwGYTahdrR` and `YxLgWnIaRWboZZVjyGFQY`).
- `src/__tests__/worker/invalid-result-recovery.test.js` — worker that would have errored with `invalid_result` now succeeds via lenient parse.
- `src/__tests__/coordinator/watcher/schema-correction-continuation.test.js` — when lenient parse also fails, a continuation is scheduled with the right diagnostics; second failure escalates.

### Agent-config (A1)

- `data-template/agents/benchmark-qa-reviewer/system_prompt.md` — tighten the "output contract" section: explicit final-block format `<JSON START> { ... } <JSON END>` (or whatever delimiter convention exists already — verify in `src/agent/prompt/system-prompt.js`); examples; "no markdown fences" rule.
- Mirror the same tightening for any other reviewer agents (`benchmark-product-lead` reviewed once on M6 E2E smoke and once on M7D).

### Phase 2 exit checklist

- [ ] Replay both failed reviewer outputs through `parseWorklabResultLenient` — both succeed without continuation.
- [ ] Synthesised "garbage final text" triggers a `schema_correction` continuation with the right diagnostic markers.
- [ ] All baseline tests green.
- [ ] Commits: `feat(ai): lenient worklab.v2 parser (R3a)`, `feat(coordinator): schema_correction continuation for invalid_result (R3b)`, `chore(agents): tighten reviewer JSON-only contract (A1)`.

---

## Phase 3 — Salvage partial progress on `provider_unavailable` (R2 + R8) — High

**Goal.** When a Codex run terminates with `had_partial_progress: true` and the last tool was `journal_summary`, **don't retry it as if nothing happened**. Treat it as `decision: needs_finalisation`, surface to the operator, and run a cheap "finalise" continuation that observes the workdir state and emits the structured envelope.

Folds in R8: when a continuation completes the work, reset the continuation budget so a subsequent transient drop doesn't burn the budget on a finished task.

### Files

- `src/ai/failure.js` — new sub-kind constant `terminated_after_completion` (kept under the `provider_unavailable` umbrella for backwards compatibility, surfaced separately in diagnostics). Update `classifyFailure()` to set it when `error_details.had_partial_progress && (error_details.last_tool_name === 'journal_summary' || /* clean worktree heuristic */)`.
- `src/coordinator/watcher/failure-classifier.js` — branch on `terminated_after_completion` to schedule a *finalisation* continuation (single-attempt, short timeout, system prompt: *"Your previous run completed work but the provider connection dropped before you could emit the worklab.v2 envelope. Inspect the workdir, confirm the work is done, and emit the JSON envelope only."*).
- `src/coordinator/watcher/run-handler.js` — when a continuation succeeds against a `terminated_after_completion` parent, reset `continuation_depth` for sibling runs in the same chain.
- `src/agent/transcript.js` — finalisation continuations need a different snapshot: include the parent's `journal_summary` payload + the latest git status, *not* the full transcript (no need to re-think 100+ turns).
- `src/coordinator/watcher/run-handler.js` (again) — diagnostics: persist `recovery_kind: "finalisation"` distinct from `recovery_kind: "provider_retry"` and `recovery_kind: "schema_correction"`.

### New helper

`src/coordinator/watcher/workdir-state.js` — small read-only inspector: `inspectWorkdir(workdir)` returns `{cleanWorktree: boolean, latestCommit: string | null, lastJournalEntry: object | null}`. Used by the finalisation prompt builder.

### Tests

- `src/__tests__/coordinator/watcher/terminated-after-completion.test.js` — synthesise a failed run matching the `Ec6ZSCipMSKGAdlhfV88S` shape (had_partial_progress=true, last_tool_name=journal_summary, clean worktree). Assert the failure_classifier sets `terminated_after_completion` and schedules a *finalisation* continuation.
- `src/__tests__/coordinator/watcher/finalisation-success-resets-budget.test.js` — after a successful finalisation, `continuation_depth` resets so a subsequent provider drop spawns a fresh recovery.
- `src/__tests__/agent/workdir-state.test.js` — inspector returns correct values against a temp git repo.

### Phase 3 exit checklist

- [ ] Replaying a fixture matching `Ec6ZSCipMSKGAdlhfV88S` results in a 1-shot finalisation continuation that emits the worklab_result envelope from the existing journal entry.
- [ ] No regression on the existing 4-out-of-6 "fast-fail" provider_unavailable cases (they still get the regular provider_retry continuation).
- [ ] All baseline tests green.
- [ ] Commits: `feat(ai): terminated_after_completion sub-kind (R2)`, `feat(coordinator): finalisation continuation for ghost-success (R2)`, `feat(coordinator): reset continuation budget on completion (R8)`.

---

## Phase 4 — Coordinator shutdown handling (R5) — Medium-High

**Goal.** Stop classifying coordinator restarts as `cancelled_stale`. Drain in-flight workers gracefully on shutdown. Persist enough state to resume on next start.

### Files

- `src/ai/failure.js` — add `cancelled_shutdown` to `FAILURE_KINDS`. Update `classifyFailure()` to map `cancel_initiator: "coordinator_shutdown"` → `cancelled_shutdown` (currently maps to `cancelled_stale`).
- `src/coordinator/coordinator.js` — on `SIGTERM` / `SIGINT`, transition into a "draining" state: stop accepting new spawns, send a `worklab_drain` signal to each active worker, wait up to `worklab_drain_timeout_ms` (default 60_000) for them to emit a partial worklab_result.
- `src/cli/start.js` and `src/cli/stop.js` and `src/cli/restart.js` — make the drain timeout configurable via `--drain-timeout-ms` and via `worklab.coordinator.drain_timeout_ms` setting.
- `src/worker.js` — handle the new drain signal: stop new tool calls, finish the in-flight tool, emit a `decision: pause / pending_actions: ["resume from drained state"]` worklab_result, exit cleanly.
- `src/agent/transcript.js` — when a worker drains, persist a resume snapshot tagged `resume_kind: "drained"` so the next coordinator boot can pick it back up.
- `src/coordinator/watcher/stale-runs.js` — `reconcileStaleRunningRuns()` on boot: detect drained snapshots, *don't* mark them abandoned — schedule a fresh continuation with `continuation_reason: "coordinator_resume"`.
- `src/coordinator/watcher/failure-classifier.js` — branch on `cancelled_shutdown` to *not* count against failure budgets.

### Tests

- `src/__tests__/coordinator/shutdown-drain.test.js` — coordinator with one active worker receives SIGTERM, worker emits a drained worklab_result within timeout, run is marked `cancelled_shutdown`.
- `src/__tests__/coordinator/shutdown-drain-timeout.test.js` — worker that doesn't drain in time gets SIGTERM'd; classified as `cancelled_shutdown` with `drain_timeout: true` diagnostic.
- `src/__tests__/coordinator/coordinator-resume.test.js` — boot a coordinator on a DB containing a drained run; new continuation scheduled with `continuation_reason: "coordinator_resume"` and resume snapshot loaded.
- `src/__tests__/cli/restart-flag.test.js` — `worklab restart --drain-timeout-ms=10000` is parsed and propagated.

### Phase 4 exit checklist

- [ ] Synthesised replay of the M7D coordinator-restart cluster results in 0 lost work (all 3 cancelled-stale workers drain cleanly and resume on next boot).
- [ ] `failure_count` is unchanged after a coordinator restart.
- [ ] Baseline tests green.
- [ ] Commits: `feat(ai): cancelled_shutdown failure kind (R5)`, `feat(coordinator): drain workers on shutdown (R5)`, `feat(coordinator): resume drained workers on boot (R5)`, `feat(cli): --drain-timeout-ms flag (R5)`.

---

## Phase 5 — Diagnostic & observability fixes (R4 + R11 + R12) — Medium

**Goal.** Add the three observability gaps the audit flagged: cumulative counters, parent-relationship column, session-id reuse. None of these change behaviour by themselves; they make the next audit much faster.

### R4 — cumulative counters

- New migration `src/core/db/migrations/<n>-task-cumulative-counters.js` — adds `tasks.lifetime_failure_count`, `tasks.lifetime_rejection_count`, `tasks.lifetime_recovery_continuation_count`. Backfill via `task_runs` count queries.
- `src/core/db/queries/tasks.js` — new helpers `incrementLifetimeFailure()`, etc. Wire from `src/core/state-machine.js` `run_failed` / `run_rejected` handlers.
- `src/core/db/queries/tasks.js` — add a `getTaskHealth(taskId)` view returning the lifetime counters + `last_failure_kind` + `peak_context_risk` (computed from `task_runs.diagnostics_json`).
- `src/api/routes/tasks.js` — expose `task_health` on the task detail response.
- `src/ui/src/routes/...` — surface in the task detail view (badge: "needed 2 retries", etc.). Identify exact route paths in `src/ui/src/routes/`.

### R11 — parent_relationship column

- New migration `src/core/db/migrations/<n>-task-runs-parent-relationship.js` — adds `task_runs.parent_relationship TEXT` with values `stage_progression | recovery_continuation | manual_retry`. Backfill from existing `diagnostics_json.continuation_*` keys.
- `src/coordinator/watcher/run-handler.js` and `src/coordinator/watcher/spawn-run.js` — set the column on every new run.
- `src/core/db/queries/runs.js` — accept the new column on insert/update.

### R12 — session_id reuse

- `src/ai/providers/pi-sdk.js`, `src/ai/providers/claude-sdk.js`, `src/ai/providers/codex-app.js`, `src/ai/providers/claude-cli.js` — when spawning a run that has `parent_run_id` and the parent's `provider_session_id` is non-null, reuse it (provider permitting; some providers won't honour reused sessions across processes — check each).
- `src/coordinator/watcher/run-handler.js` — pass parent's `provider_session_id` into the spawn payload for continuations.
- `src/core/db/queries/runs.js` — ensure `provider_session_id` is recorded reliably even on errored runs (audit open question §6).

### Tests

- `src/__tests__/core/db/migrations/cumulative-counters.test.js` — migration runs on a synthesised DB with mixed pass/fail history, counters match.
- `src/__tests__/core/db/migrations/parent-relationship.test.js` — backfill correctly classifies existing rows into the three categories.
- `src/__tests__/ai/providers/*.session-reuse.test.js` — provider-specific tests for each SDK that supports session reuse.
- `src/__tests__/api/routes/tasks-health.test.js` — task detail endpoint exposes lifetime counters.

### Phase 5 exit checklist

- [ ] Migrations run cleanly on a synthesised copy of the audit-period DB; counters match what the audit's `analyze.py` computed.
- [ ] `task_runs.parent_relationship` is non-null for every new run after this phase lands.
- [ ] At least one provider demonstrably reuses session_id on a recovery continuation.
- [ ] Baseline tests green.
- [ ] Commits: per recommendation, e.g. `feat(core): cumulative task counters (R4)`, `feat(db): parent_relationship column on task_runs (R11)`, `feat(ai): reuse provider_session_id on continuations (R12)`.

---

## Phase 6 — Plan-driven join policy + per-agent idle thresholds (R6 + R7) — Medium

### R6 — plan-driven join policy

- `src/core/db/schema/current.js` and migration — add `tasks.parent_review_policy TEXT` with values `default | skip_when_qa_child | always_skip` (default: `default`).
- `src/ai/result/contract.js` — extend the `worklab.v2` envelope to allow a planner to request `parent_review_policy` on the parent task as part of its `delegate` decision.
- `src/coordinator/watcher/delegation-handler.js` — when a plan delegates and includes a `*-qa-*` child, automatically apply `skip_when_qa_child` (unless explicitly overridden).
- `src/core/state-machine.js` — when the parent task's children all complete, consult `parent_review_policy`:
  - `default` → spawn parent.review as today.
  - `skip_when_qa_child` → if any child agent matches `/qa|review/`, skip parent.review and auto-approve.
  - `always_skip` → skip parent.review unconditionally.
- `src/coordinator/watcher/delegation-handler.js` — auto-approve QA-child meta-reviews when executor-agent === reviewer-agent and executor's decision was `advance`/`approve` (no LLM call, just an API-emitted approve event).

### R7 — per-agent idle thresholds

- `src/core/settings.js` (or wherever settings live) — add per-agent override: `agents.<name>.idle_threshold_ms` (defaults to global 120_000, but qa-reviewer gets 240_000).
- `src/coordinator/watcher/run-handler.js` — read per-agent threshold when emitting idle warnings.
- `src/api/sse.js` and the warning emitter — include `last_tool_name` from the most recent `tool_use` event in the idle warning body.
- UI: the run detail page's idle warning rendering should show the last tool name. Identify path in `src/ui/src/routes/` and `src/ui/src/components/`.

### Tests

- `src/__tests__/coordinator/watcher/parent-review-skip.test.js` — delegation pattern with a QA child triggers parent.review skip; without a QA child, it doesn't.
- `src/__tests__/coordinator/watcher/qa-meta-review-auto-approve.test.js` — when executor === reviewer, no LLM call is made; approval is recorded directly.
- `src/__tests__/coordinator/idle-threshold-per-agent.test.js` — qa-reviewer doesn't trigger idle warning at 130s; runtime-engineer does.
- `src/__tests__/api/sse-idle-warning-tool.test.js` — idle warning SSE payload includes `last_tool_name`.

### Phase 6 exit checklist

- [ ] Synthesised M5 test-inspection delegation pattern (parent + impl-child + qa-child) shows 2 review passes (impl + qa) instead of 3.
- [ ] qa-reviewer no longer trips idle warnings at 130s with playwright snapshot context.
- [ ] Baseline tests green.
- [ ] Commits: `feat(core): plan-driven parent_review_policy (R6)`, `feat(coordinator): auto-approve qa-child meta-review (R6)`, `feat(coordinator): per-agent idle thresholds (R7)`.

---

## Phase 7 — Cancellation reasons + agent fleet enforcement (R9 + R10) — Low-Medium

### R10 — required cancel_reason

- `src/api/routes/tasks.js` (cancel endpoint) — require a `reason` body field. Accept an enum `wrong_direction | agent_stuck | context_bloat | scope_change | other` plus an optional free-text `reason_note`.
- New migration — none needed; `task_runs.cancel_reason` exists.
- `src/coordinator/watcher/run-handler.js` — propagate the structured reason into `task_runs.cancel_reason`.
- UI: cancel modal must collect the picklist + optional note. Path in `src/ui/src/`.

### R9 — project allowed_agents allowlist

- New migration — adds `projects.allowed_agents_json TEXT NOT NULL DEFAULT '[]'`. Empty array means "any agent".
- `src/core/db/queries/projects.js` — getter/setter helpers.
- `src/coordinator/watcher/delegation-handler.js` — when the planner names an agent outside the allowlist, fail-fast with a `delegation_agent_not_allowed` failure_kind (or, if a setting `project.delegation.allow_unlisted = true`, just warn and continue).
- `src/api/routes/projects.js` — expose the allowlist in project settings GET/PATCH.
- UI: project settings page section "Allowed agents". Path in `src/ui/src/routes/projects/`.

### Tests

- `src/__tests__/api/routes/cancel-reason-required.test.js` — cancel without reason returns 400; with reason succeeds and persists.
- `src/__tests__/coordinator/watcher/delegation-allowlist.test.js` — planner delegating to an agent outside the allowlist fails-fast unless the setting is on.
- `src/__tests__/api/routes/project-allowed-agents.test.js` — read/write of the allowlist.

### Phase 7 exit checklist

- [ ] All cancel events from this point forward carry a structured reason.
- [ ] Setting `project.allowed_agents = ['benchmark-*']` on the audit project would have blocked the `github-dev` one-off run.
- [ ] Baseline tests green.
- [ ] Commits: `feat(api): require cancel_reason on task cancel (R10)`, `feat(core): project allowed_agents allowlist (R9)`.

---

## Phase 8 — Agent budgets + project default policies (A3 + A4) — Low

### A3 — per-agent run-budget warnings

- New module `src/core/agent-budgets.js` — `evaluateBudget(agent, runStats)` returns `{soft_warn: bool, hard_pause: bool, reason?: string}`.
- Configuration: per-agent JSON file under `data-template/agents/<agent>/budget.json`:
  ```json
  {
    "soft": {"cost_usd": 5, "duration_ms": 1200000, "num_turns": 150},
    "hard": {"cost_usd": 20, "duration_ms": 3600000, "num_turns": 300}
  }
  ```
- `src/coordinator/watcher/run-handler.js` — on every `tool_result` event, evaluate the budget. Soft → emit a warning + post a comment. Hard → cancel the run with `cancelled_budget`.
- `src/ai/failure.js` — `cancelled_budget` failure_kind already exists conceptually (`budget_exceeded`); reuse.
- UI: warning indicator on the run detail.

### A4 — project default policies

- `data-template/projects/_defaults.json` — new file with default `run_policy: "auto_plan_execute"`, `parent_review_policy: "skip_when_qa_child"`, etc. — i.e. baked-in best-practice defaults derived from the audit.
- `src/core/db/queries/projects.js` — apply defaults on project creation.
- `src/cli/...` — `worklab project create --policy <preset>` flag (optional, can defer).

### Tests

- `src/__tests__/core/agent-budgets.test.js` — soft/hard threshold logic.
- `src/__tests__/coordinator/watcher/budget-cancel.test.js` — a runaway run gets cancelled at the hard threshold.
- `src/__tests__/core/db/queries/project-defaults.test.js` — new project picks up the bundled defaults.

### Phase 8 exit checklist

- [ ] A synthesised "runtime-engineer running 1500 s with $30 spend" gets cancelled at the hard threshold with `cancelled_budget`.
- [ ] New projects created via the API or CLI inherit the bundled defaults.
- [ ] Baseline tests green.
- [ ] Commits: `feat(core): per-agent run budgets (A3)`, `chore(data): project default policies (A4)`.

---

## Phase 9 — Documentation, audit-doc updates, and end-of-branch hygiene (≈ 0.5 day)

**Goal.** Make sure the audit doc, README, and CLAUDE.md reflect the new behaviours so the next reader doesn't fight them.

### Steps

1. Update `docs/audits/automattic-benchmark-reset-runtime-audit.md`:
   - Add a "Status" callout at the top: each R# / A# now linked to the commit(s) implementing it.
   - Add a brief "What changed" appendix summarising new failure_kinds, new diagnostics fields, new settings keys.
2. Update `CLAUDE.md`:
   - Note the new `tool_payload_max_bytes` setting and the `tool-bloat.js` module.
   - Note the `cancelled_shutdown` failure kind alongside `cancelled_stale`.
   - Note the `parent_review_policy` field on tasks.
   - Note the `lifetime_*` task counters.
3. Update `src/coordinator/README.md` and `src/agent/README.md` and `src/ai/README.md`:
   - Each gets a "Recovery flows" section diagramming `provider_retry`, `schema_correction`, `finalisation`, `coordinator_resume` continuation kinds.
4. Update `data-template/agents/README.md` with the new prompt conventions.
5. Run the *full* verification suite:
   - `npm test`
   - `npm run test:coverage`
   - `npm run build:ui`
   - `./scripts/guard-imports.sh`
   - `./scripts/guard-banned-tokens.sh`
   - `npm run lint`
   - One end-to-end: spin up `worklab serve` against a temp data dir, create a small project, watch one run end-to-end. (Document the steps in the audit appendix.)

### Phase 9 exit checklist

- [ ] All gates green.
- [ ] Audit doc is current.
- [ ] CLAUDE.md is current.
- [ ] No `TODO(audit-followup)` comments left without a corresponding line in this plan or an issue link.
- [ ] Branch ready for PR.
- [ ] Final commit: `docs(audit): mark all R# / A# recommendations implemented`.

---

## Phase 10 — PR (≈ 0.25 day)

**Goal.** Open the PR. Don't auto-merge.

### Steps

1. `git push -u origin runtime-audit-implementation`
2. `gh pr create --title "Runtime audit implementation: R1–R12, A1–A4" --body "<from template>"`
3. PR body lists every R# / A# with one-line summaries and links to the per-commit diffs. Use the audit's "Order of attack" as the narrative spine.
4. Add `## Test plan` section that mirrors the per-phase exit checklists.
5. Stop. Wait for human review.

---

## Cross-cutting non-goals (do not attempt)

These are explicitly *out of scope* for this branch even though the audit mentions them:

- **The audit's open questions §10.** Keep them as `TODO(audit-followup)` markers; do not speculate.
- **External repository state** (the agents' workdir at `~/Automattic_Repositories/A-Benchmark-2`). Out of scope.
- **The sibling `automattic-benchmark` project.** Out of scope.
- **Any UI redesign that goes beyond surfacing the new fields.** Use the existing primitives in `src/ui/src/components/primitives/` and the design tokens in `src/ui/src/styles.css`. No new colours, no new font sizes — `./scripts/guard-banned-tokens.sh` will fail and rightly so.
- **Re-running agents against the audit-period project.** No replay against `~/.worklab/worklab.db`. All test fixtures are synthesised under tmp dirs.

## Final acceptance — what "done" means for this branch

- All R1–R12 and A1–A4 recommendations have at least one commit referencing them.
- `git log main..runtime-audit-implementation --oneline` is a clean conventional-commit history.
- `npm test` is green.
- The audit doc has a "Status" table where every recommendation is `Done`.
- The PR is open against `main` with the test plan.
- This file (`automattic-benchmark-reset-implementation-plan.md`) is updated with a final "Implementation log" section at the bottom listing each commit SHA against each recommendation.

---

## Implementation log

| Phase | Recommendation | Commit | Notes |
|---|---|---|---|
| pre-0 | baseline lint | `3e7896c` | Re-export edge-consumed core helpers through `src/core/index.js` so the boundary lint goes green. Pre-existing baseline failure unrelated to the plan. |
| 0 | scaffold | `f815e9c` | `src/agent/tool-bloat.js` and `src/ai/result/lenient-parse.js` stubs + agent-barrel exports. Migration plumbing exercised by existing `src/__tests__/core/db.test.js`. |
| 1 | R1 (cap) | `28c128d` | `summarisePayload` + `wrapToolsWithBloatGuard`. Wrapped `getPiBuiltinTools` and `initPiMcpTools` returns. |
| 1 | R1 (persist) | `6852163` | `runArtifactDir` plumbed via `WORKLAB_QA_OUTPUT_DIR` env. New `agent_tool_payload_max_bytes` setting. `tool_results_truncated` aggregated into `task_runs.diagnostics_json`. |
| 1 | A2 | `92a89af` | REVIEW_DIRECTIVE tool-budget paragraph (prefer `browser_snapshot` over `browser_take_screenshot`). User-side agent files flagged via `TODO(audit-followup)`. |
| 2 | R3a | `226ae72` | `parseWorklabResultLenient` + worker fallback + `result_recovered_via_lenient` runtime warning surfaced as `diagnostics.result_recovered_via`. |
| 2 | R3b + A1 | `e7998a9` | `schema_correction` continuations capped at 2. REVIEW_DIRECTIVE JSON-only output contract. |
| 3 | R2 + R8 | `be25e09` | `terminated_after_completion` subkind detected from `error_details.last_tool_name === "journal_summary"`; `finalisation` recovery reason with single-attempt cap and "do NOT redo the work" prompt. R8 implicit in `continuationLineage` walking `continuation_of_run_id` only. |
| 4 | R5 | `1a0eb78` | `cancelled_shutdown` failure kind split from `cancelled_stale`. Configurable `WORKLAB_DRAIN_TIMEOUT_MS` (default 60 s). Drained-resume protocol deferred. |
| 5 | R4 + R11 + R12 | `49265f6` | SCHEMA_VERSION 25. Lifetime counters + backfill. `parent_relationship` column + backfill. pi-sdk session_id reuse via `WORKLAB_PROVIDER_SESSION_ID`. `getTaskHealth` exposed as `task.health` on the task detail endpoint. |
| 6 | R7 | `0766282` | `agent_review_idle_threshold_ms` (default 240 s) for review-mode runs. `last_tool_name` in idle-warning payload. R6 deferred via `TODO(audit-followup)`. |
| 7 | R10 | `3a707b2` | `reason_kind` enum on `/api/tasks/:id/cancel` (wrong_direction / agent_stuck / context_bloat / scope_change / other). `reason_note` free-text. R9 deferred via `TODO(audit-followup)`. |
| 8 | A4 | `74e4882` | `data-template/projects/_defaults.json` with audit-derived defaults. A3 (per-agent budgets) deferred via `TODO(audit-followup)`. |
| 8 | A3 | `75a045e`, `6108812` (integration), `89e14a3` (`classifyFailure` mapping) | `src/core/agent-budgets.js` (`evaluateBudget` + `loadAgentBudget` + `DEFAULT_AGENT_BUDGET`). `data-template/agents/_defaults/budget.json` ships the audit's numbers (5/20 USD, 20/60 min, 150/300 turns). Budget aggregator runs on every `tool_result` in spawn-worker; soft → `runtime_warning` + system comment, hard → cancel with `cancel_initiator="budget"` so `classifyFailure` maps to existing `budget_exceeded` kind. Coverage in `src/__tests__/core/agent-budgets.test.js` (16 unit tests for soft/hard threshold logic and the loader fallback chain) and `src/__tests__/coordinator/watcher/budget-cancel.test.js` (3 integration tests covering the runaway-run cancel, soft-only, and no-warning paths). UI surface: `RunBudgetBadge` on the run-card summary + `run-warning-budget-soft|hard` tones in `src/ui/src/styles.css`. cost_usd is currently driven by streamed usage only (zero during streaming for most providers); duration + num_turns proxy carries the load — follow-up: extend to per-event cost when providers stream usage incrementally. Merge collisions with R5/R6/R9 distributed individual hunks across `6108812`, `89e14a3`, and `65a7fee`; the cohesive A3 surface still spans `agent-budgets.js` + `spawn-worker.js` + `delegation-handler.js` + UI. |
| 7 | R9 | `fd500fe` (schema), `6f68396` (helpers), `89e14a3` (enforcement), `5635f19` (API), `f709985` (UI), `a91f96b` (tests landed under parallel R6 commit due to staging race) | New `projects.allowed_agents_json TEXT NOT NULL DEFAULT '[]'` + `projects.delegation_allow_unlisted INTEGER NOT NULL DEFAULT 0` columns (SCHEMA_VERSION 26 → 27, sequenced after R6). `parseProjectAllowedAgents` + `agentNameMatchesPattern` simple-glob helpers in `src/core/projects.js` (e.g. `["benchmark-*"]` matches every agent whose name starts `benchmark-`). `enforceProjectAgentAllowlist` in `src/coordinator/watcher/delegation-handler.js` short-circuits delegation outside the allowlist with `delegation_agent_not_allowed` failure_kind unless `delegation_allow_unlisted` is set on the project, in which case the delegation proceeds and a soft warning + system comment surface. POST/PATCH `/api/projects` accept `allowed_agents` (string array, dedupe + trim) and `delegation_allow_unlisted` (boolean); GET round-trips both. Project edit page gains a third "Allowed agents · Delegation" section with `TagInput` + `Switch` (no new tokens introduced). Coverage: `src/__tests__/coordinator/watcher/delegation-allowlist.test.js` (12 tests across the pure helper + watcher integration) and `src/__tests__/api/routes/project-allowed-agents.test.js` (8 tests across CRUD round-trip + edge cases). |
| 6 | R6 | `2178902` (schema), `e1cc9f6` (state machine + helpers), `3010e41` (restore after R9 merge), `65a7fee` (watcher wiring), `7cff89a` (tests) | `tasks.parent_review_policy TEXT NOT NULL DEFAULT 'default'` (SCHEMA_VERSION 26). State machine adds `PARENT_REVIEW_POLICIES` + `shouldSkipParentReview`; the execute → review boundary now consults the policy and the new `executorAgent` / `autoApproveSelfReview` event fields, emitting `post_review_verdict: AUTO-APPROVE (parent_review_policy)` or `AUTO-APPROVE (executor_is_reviewer)` directly to `done` instead of spawning a redundant review run. `worklab.v2` envelope gains an optional `parent_review_policy` field; the watcher's delegation handler resolves the planner's request through `resolveParentReviewPolicy`, falling back to QA-child detection (`isQaChildAgent` matches `/qa\|review/`). `setTaskParentReviewPolicy` + `listSubtaskChildAgents` query helpers persist the resolved policy + drive QA detection at execute-advance time. The executor === reviewer auto-approve is gated on the agent's `allow_self_review` flag so the existing self-review enforcement still wins when forbidden. Coverage: `src/__tests__/coordinator/watcher/parent-review-skip.test.js` (8 tests) + `src/__tests__/coordinator/watcher/qa-meta-review-auto-approve.test.js` (3 tests). Removes the R6 TODO from `delegation-handler.js`. |

### Status by recommendation

| ID | Status | Commit |
|---|---|---|
| R1 | Done | `28c128d`, `6852163` |
| R2 | Done | `be25e09` |
| R3 | Done | `226ae72`, `e7998a9` |
| R4 | Done | `49265f6` |
| R5 | Partial — drained-resume protocol deferred | `1a0eb78` |
| R6 | Done | `2178902`, `e1cc9f6`, `3010e41`, `65a7fee`, `7cff89a` |
| R7 | Done | `0766282` |
| R8 | Done (implicit) | `be25e09` |
| R9 | Done | `fd500fe`, `6f68396`, `89e14a3`, `5635f19`, `f709985` |
| R10 | Done | `3a707b2` |
| R11 | Done | `49265f6` |
| R12 | Done (pi-sdk only — other providers follow-up) | `49265f6` |
| A1 | Done | `e7998a9` |
| A2 | Done | `92a89af` |
| A3 | Done (UI surface + integration) | `75a045e`, `6108812`, `89e14a3` |
| A4 | Done | `74e4882` |
