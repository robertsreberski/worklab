# Worklab Runtime Audit — `automattic-benchmark-reset` Project

> **Status:** draft, 2026-05-02
> **Implementation status:** see `automattic-benchmark-reset-implementation-plan.md` § Status by recommendation. All R1–R12 and A1–A4 recommendations landed on branch `runtime-audit-implementation`. R5 was finished in two halves: the `cancelled_shutdown` failure-kind split + configurable drain timeout shipped with the rest of Phase 4, and the graceful drained-resume protocol — `worklab_drain` IPC, transcript-tail snapshot tagged `resume_kind: "drained"`, boot-time `coordinator_resume` continuation — landed in commits `6108812`, `82c936a`, and `f709985`.
> **Author:** Claude (Opus 4.7) running an end-to-end audit of every run in the project
> **Scope:** every task and every run on project `CRoBAXtjQxo0` (`automattic-benchmark-reset`), May 1–2 2026
> **Source data:** `~/.worklab/worklab.db` snapshot taken on 2026-05-02 at audit time
> **Working files:** `tmp/runtime-audit/` (raw JSON per task, run index, lifecycle dump, analysis script output)

---

## What changed in the harness

This appendix lists the user-visible additions that landed during the
implementation pass. Configuration keys without docs elsewhere live here.

### New `task_runs.diagnostics_json` fields

- `tool_results_truncated` (number) — count of tool-result payloads the
  R1 bloat guard had to truncate during the run.
- `result_recovered_via` ("lenient") — set when R3a's lenient parser
  recovered a worklab.v2 envelope after the strict parse failed.
- `error_details.last_tool_name` / `had_partial_progress` — used by R2 to
  detect `terminated_after_completion`. (Already populated by pi-sdk; R2
  taught the watcher to read them.)

### New failure kinds

- `cancelled_shutdown` (R5) — split from `cancelled_stale`; cancellation
  requested by an active coordinator's SIGTERM/SIGINT handler. Does not
  count against the failure budget.

### New `task_runs` columns

- `parent_relationship` (R11) — `stage_progression | recovery_continuation
  | manual_retry | NULL`. Disambiguates the overloaded `parent_run_id`.

### New `tasks` columns

- `lifetime_failure_count`, `lifetime_rejection_count`,
  `lifetime_recovery_continuation_count` (R4) — monotonic counters that
  survive `reset_failure_count`.

### New settings keys

- `agent_tool_payload_max_bytes` (R1, default 262144 = 256 KB).
- `agent_review_idle_threshold_ms` (R7, default 240000 = 4 min).

### New env vars

- `WORKLAB_DRAIN_TIMEOUT_MS` (R5, default 60000) — coordinator shutdown
  watchdog timeout.
- `WORKLAB_PROVIDER_SESSION_ID` (R12) — set by the spawn path on recovery
  continuations so pi-sdk reuses the parent's session_id.

### New continuation reasons

- `finalisation` (R2) — single-shot continuation when the agent finished
  the work but dropped before emitting the worklab.v2 envelope.
- `coordinator_resume` (R5) — fresh continuation scheduled at the next
  coordinator boot when the previous coordinator drained the worker
  cleanly on shutdown. The continuation receives the parent run's
  transcript-tail snapshot via `diagnosticsSeed.resume_snapshot` so the
  agent can pick up rather than restart.

### New API request shape

- `POST /api/tasks/:id/cancel` (R10) accepts `reason_kind` enum
  (`wrong_direction | agent_stuck | context_bloat | scope_change | other`)
  and `reason_note` free text. The legacy `reason` field still works.

---

## 1. Executive summary

The `automattic-benchmark-reset` project is the strongest end-to-end test of the v2 agent harness so far: 24 root tasks, 35 delegated children, 159 worker runs, 5 specialised agents, 17 hours of wall-clock work, $213.51 of provider spend, and **all 24 root tasks completed**. The harness shipped the work. But the data shows several systemic frictions that cost wall-clock time, money, and operator confidence — and at least two genuine correctness gaps that only didn't bite the user because they intervened by hand.

**TL;DR (5 bullets):**

1. **Plan/execute/review with delegation works.** 145/159 runs (91%) succeeded. Reviewer rejections (n=2) were both correct catches of real runtime bugs (`OperationalRow` undefined, `KeyValueList` prop mismatch).
2. **The single biggest avoidable cost is `mcp__playwright__browser_take_screenshot` returning huge base64 payloads.** 45/159 runs (28%) tripped the `context_bloat` warning. The QA reviewer hit it on virtually every mobile-QA run, with single tool results up to **1.44 MB** and aggregate event payloads up to **13.9 MB** per run.
3. **Provider-error recovery for the Codex (`pi-sdk`) provider is brittle.** All 6 `provider_unavailable` events came from the codex provider with `pi_stop_reason: error` and a generic "terminated" message. One continuation (`Ec6ZSCipMSKGAdlhfV88S`) ran for **998s, completed the work, committed `17c89b7`, called `journal_summary`** — and *then* terminated, getting reclassified as a failed continuation even though the task was effectively done.
4. **`invalid_result` on review does not auto-recover.** Both occurrences (`01i6FI78ATSpwGYTahdrR`, `YxLgWnIaRWboZZVjyGFQY`) were silently abandoned by the harness. M4 only completed because something (user, or a delayed re-trigger) spawned a fresh review 24 minutes later with no `recovery_*` diagnostics. M3 Df4 was simply marked `done` without a successful review at all (`failure_count` stayed at 0 — there is no audit trail of how it advanced).
5. **`cancelled_stale` is masking coordinator restarts.** Three of the four "stale" cancellations on this project were actually `coordinator_shutdown`/"coordinator stopping" events. ~13 minutes of wasted execute work on M7D and ~8 minutes on M7C were burned because the coordinator was being bounced. Surfacing this distinction would let the operator decide whether to wait for the in-flight worker to wrap up.

**Top 3 recommendations to act on first:**

| # | Recommendation | Severity | Affects |
|---|---|---|---|
| R1 | Cap or sidestep `playwright_browser_take_screenshot` payloads (return file path + thumbnail, not raw base64; or compact in `pi-bridge.js`/`tools/index.js`). | **Blocking** | qa-reviewer, all UI verification flows |
| R2 | Treat `provider_unavailable` continuations as **success-when-result-already-emitted**: detect `journal_summary` / commit-already-made / clean worktree before re-running a 16-minute Codex job. Or, surface partial-success as a "needs human review" state instead of `error`. | **High** | runtime-engineer, all long Codex executes |
| R3 | Make `invalid_result`-on-review actually recover. Either (a) implement the `schema_correction` continuation that the source-code exploration suggested exists but which produces *zero* `recovery_*` diagnostics in this dataset, or (b) wrap the QA reviewer's final response in a code-block-stripping JSON parser before failing the run. | **High** | qa-reviewer, both invalid_result tasks |

---

## 2. Methodology and dataset

### 2.1 Methodology

This audit was generated by reading every artifact tied to project `CRoBAXtjQxo0` end-to-end. There was no sampling.

For each of the 24 root tasks (and the 35 delegated children threaded under them):

1. The full row from `tasks` was extracted, including `plan_body`, `pending_actions_json`, `blocking_issues_json`, `pending_questions_json`, `failure_count`, `rejection_streak`, and `last_failure_kind`.
2. Every row in `task_runs` for that task was extracted, with the parsed `result_json`, `transcript_tail_json`, `diagnostics_json`, `warnings_json`, `artifact_summary_json`, and `parent_run_id` chain.
3. The matching `agent_logs` row (event stream, tokens, `model`, `effort`, `cost_usd`, `duration_ms`, `num_turns`) was joined in.
4. `task_comments` were threaded into the per-task timeline.
5. The 14 non-success runs were re-read at the event level, and on-disk `raw_output_path` files were inspected where the `transcript_tail_json` was insufficient.

The extraction script (`tmp/runtime-audit/extract.py`), summary generator (`tmp/runtime-audit/summarize.py`), per-task lifecycle dumper (`tmp/runtime-audit/lifecycle.py`), and cross-cutting analyser (`tmp/runtime-audit/analyze.py`) are checked into the working directory and reproduce all numbers in this document.

Cost figures use the `cost_usd` column on `task_runs` and `agent_logs`. Duration is `(ended_at - started_at) / 1000`. Token counts come from `agent_logs.input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_creation_tokens`. Cache hit ratio is `cache_read / (input + cache_read)`.

### 2.2 Dataset shape

| Metric | Value |
|---|---|
| Project ID | `CRoBAXtjQxo0` |
| Project name / slug | `Automattic Benchmark Reset` / `automattic-benchmark-reset` |
| Wall-clock window | 2026-05-01 17:23:48 → 2026-05-02 10:53:53 (≈ 17.5 h) |
| Tasks (root) | 24 |
| Tasks (delegated children, depth 1) | 35 (14 QA, 21 implementation) |
| Tasks (depth 2+) | 0 |
| Total worker runs | 159 |
| Successful runs | 145 (91.2%) |
| Errored runs | 8 (5.0%) |
| Cancelled runs | 6 (3.8%) |
| Distinct agents used | 6 (5 benchmark-* agents + 1 stray `github-dev`) |
| Total provider spend | **$213.51** |
| Total input tokens (live) | 10,069,961 |
| Total output tokens | 1,435,912 |
| Avg run duration | 298 s |

All 59 task rows ended in `stage = 'done'`. All `failure_count` and `rejection_streak` columns are `0` — these reset on success, which means the historical incident counts here are *not* visible from the task table alone and have to be reconstructed from `task_runs`. (See §6 finding F4.)

### 2.3 Scope limits

- **External repository state is out of scope.** The agents were modifying `~/Automattic_Repositories/A-Benchmark-2`. The audit cannot directly observe whether commit `17c89b7` is "good code" — only whether the harness emitted, recorded, and reviewed it correctly.
- **Sibling project `automattic-benchmark` (`chxyE8vOorRJ`) is out of scope** by user request.
- **No re-execution.** All findings are derived from stored state. Where a finding requires reproducing a failure, it's flagged as a follow-up.

---

## 3. Project snapshot

### 3.1 Roadmap

The 24 root tasks are organised as the V1 benchmark workspace milestones:

| Task ID | Title | Runs | Outcome | Cost | Wall-clock |
|---|---|---:|---|---:|---:|
| `dNLIU1a3JS4kzJktaEjj7` | M0: Confirm V1 architecture and implementation sequence | 3 | ✅ approve | $1.48 | 7m |
| `lXxkiwZpF8aq4EWkbOjWT` | M1: Introduce Benchmark workspace shell and navigation | 3 | ✅ approve | $4.19 | 11m |
| `YtuwsahgV8nBdQocSOfZw` | M1: Add lightweight verification and fixture foundation | 3 | ✅ approve | $3.39 | 10m |
| `6FdEjoguViyBFQD7TaX7u` | M2: Implement modular persistence and service boundaries | 4 | ✅ approve (1 retry) | $5.02 | 19m |
| `uHy4CqZPSYmKTRcNctSj8` | M2: Implement API and event interface layer | 3 | ✅ approve | $4.56 | 15m |
| `3uN2OgiGSkRVko2z5L3UW` | M2: Implement count-based GitHub PR import | 3 | ✅ approve | $5.17 | 17m |
| `kBzJvxzf2z8BydZMlvHHx` | M2: Build PR import and grouped review workspace | 6 | ✅ approve (1 user-cancel + 1 reject loop) | $8.14 | 38m |
| `gOjEtTec9vpOuMqOvp9Ku` | M2: Build PR detail review surface | 3 (+4 children) | ✅ approve | $7.66 | 30m |
| `XeD4c8peANDHKnprSUaXS` | M3: Implement Pi-style AI runtime boundary | 3 (+5 children) | ✅ approve (1 user-cancel) | $8.27 | 49m |
| `ISl7sC6Ft1YLtCGNNUePR` | M3: Implement raw log, artifact, and normalized trace contracts | 3 (+8 children) | ✅ approve | $20.46 | 56m |
| `9W5fLBsap2Qw2fDix7R8l` | M3: Implement PR processing and human review decisions | 3 (+8 children) | ✅ approve (1 reject loop + 1 invalid_result orphan) | $24.55 | 1h31m |
| `AOxLFGvr2aypKMupwr9WX` | M3: Build Activity and contextual trace inspection | 3 (+4 children) | ✅ approve | $9.40 | 31m |
| `tYw4GF6f3oJEySgdUOHsw` | M4: Implement dataset module and UI | 4 (+6 children) | ✅ approve (1 provider error) | $9.71 | 28m |
| `hxrJLJLirAp1KROc7JpIl` | M4: Implement harness module and UI | 3 (+6 children) | ✅ approve (1 invalid_result) | $13.95 | 1h16m |
| `r27OgvezKFAa16ga1Np2i` | M5: Implement benchmark run and job matrix orchestration | 3 (+6 children) | ✅ approve | $15.14 | 38m |
| `1ihoRCNNET4kGuRPoHXCe` | M5: Implement harness execution adapters and generated diff capture | 3 (+6 children) | ✅ approve (2 provider errors) | $5.10 | 32m |
| `b6SbDV1hWnJ8C3CDMIALg` | M5: Build test inspection view | 3 (+5 children) | ✅ approve (1 provider error) | $5.49 | 31m |
| `Tf2pKb457mVhCU5cRNrH2` | M6: Add runtime readiness and operational settings | 3 (+6 children) | ✅ approve | $13.07 | 39m |
| `NvWmwpAlPFJDVI0KT5C7D` | M6: End-to-end V1 smoke path | 3 | ✅ approve | $3.13 | 12m |
| `uz4Xm3xfKLfs6wgkEEfAL` | M6: Final PRD and AGENTS compliance audit | 3 (+6 children) | ✅ approve | $22.43 | 24m |
| `SKf1SsTTU3OUfv4MmNHH6` | M7A: Add Benchmark resource route model | 4 | ✅ approve (1 user-cancel) | $2.31 | 49m |
| `85bLzge681cRDTFrEtC9Y` | M7B: Refactor PRs/Datasets/Harnesses/Activity into list/detail flows | 3 (+4 children) | ✅ approve | $11.99 | 36m |
| `5OBnNTgqmefka1AzylT2x` | M7C: Refactor Benchmarks into run/case/job drill-in routes | 3 (+4 children) | ✅ approve (1 stale-cancel) | $11.84 | 42m |
| `7KhHThu5jryTAq91XzgIT` | M7D: Mobile route QA and responsive acceptance review | 6 | ✅ approve (3 stale-cancel + 1 provider error) | $6.79 | 53m |

Cost figures here include the run cost on the root task and on every delegated child. Wall-clock is the span between the first run start and the last run end on each root.

### 3.2 Distribution of decisions

```
plan       (n=27)   advance:10  delegate:14  failed/cancelled:3
execute    (n=69)   advance:55  approve:6    failed/cancelled:8
review     (n=63)   approve:58  reject:2     failed/cancelled:3
```

The dataset has **two reviewer rejections**, both substantive:

- `9ggyujj5kpmLfo7FEoxId` (task `Df4JbTXIfHHEldaGYiUlD`, M3 UI): rejected because `KeyValueList` had a prop mismatch from a *pre-existing* bug that the new `ProcessingOutputCards` exposed in three places. The next execute fixed it in 167 s, $0.87.
- `B4oWW37kL39UWo3M3QQlZ` (task `kBzJvxzf2z8BydZMlvHHx`, M2 PR import): rejected because `OperationalRow` was used but never defined, crashing `DatasetsPage` and `ActivityPage` at runtime. The next execute fixed it in 184 s, $1.26.

Both are model behaviour we want to keep. The reviewer is doing real work.

### 3.3 Cost breakdown

```
Total: $213.51

By stage:        plan $28.90  (13.5%)   execute $162.09 (75.9%)   review $22.53 (10.5%)
By agent:        ui-engineer $63.69     qa-reviewer $42.81        platform $41.55
                 product-lead $34.08    runtime-engineer $27.36   github-dev $4.02
By provider:     codex $170.70 (80%)    claude $42.81 (20%)
```

The execute stage dominates as expected. The qa-reviewer is the second-largest line item not because individual reviews are expensive (avg $0.55) but because there are 78 of them — every review stage runs through the qa-reviewer, plus 18 of them are "QA execute" runs spawned by delegation patterns where qa-reviewer is doing the implementation work (more on this in §7).


---

## 4. Run classification matrix

The 159 runs split as follows on `(stage, status, failure_kind)`:

| stage   | status    | failure_kind            | n  | notes |
|---------|-----------|-------------------------|---:|-------|
| plan    | complete  | —                       | 24 | 14 ended in `delegate`, 10 in `advance` |
| plan    | error     | `provider_unavailable`  | 1  | `NDnzafBuAelMHHP64vihg` (M4 dataset plan, Codex terminated at 55 s) |
| plan    | cancelled | `cancelled_user`        | 1  | `T7xjZctMOuNy1ze0POdHY` (M2 PR import plan; user reset, no reason recorded) |
| plan    | cancelled | `cancelled_stale`       | 1  | `QAcRd6IsAv0lKDTtRkSHj` (M7D plan; coordinator restart at 10:01:19) |
| execute | complete  | —                       | 61 | 55 `advance`, 6 `approve` (the QA-execute pattern — see §6 F6) |
| execute | error     | `provider_unavailable`  | 4  | `DT7e7zLnjeXRVjoD0oeCF`, `W3tzSfytM969ZqmfDvz2Y`, `Ec6ZSCipMSKGAdlhfV88S`, `YYVSFAkwnNiJQkTVr4Zg7` |
| execute | cancelled | `cancelled_user`        | 2  | `4zIZKWmMnQF5mzzr4i9xb`, `H16I7AQGJzMJeK3AUsqVa` (both 13 minutes in) |
| execute | cancelled | `cancelled_stale`       | 2  | `q8Rc38XnAzDwBGSagBgPY`, `gUO3vCN2Uelvs5GXtMrPh` (both coordinator shutdown) |
| review  | complete  | —                       | 60 | 58 `approve`, 2 `reject` |
| review  | error     | `invalid_result`        | 2  | `01i6FI78ATSpwGYTahdrR`, `YxLgWnIaRWboZZVjyGFQY` (both QA reviewer / claude, "final text is not JSON") |
| review  | error     | `provider_unavailable`  | 1  | `QF2iCnxpC4OTbOT1HZaGc` (M7D review, Codex terminated mid browser_navigate) |

Cancellation is **only ever execute or plan** — never review. Errors hit all three stages but with very different distributions: every plan/execute error is a Codex provider drop; every review error is either a Codex provider drop (1/3) or a QA reviewer schema violation (2/3).

**Continuation chain analysis** (via `parent_run_id`):

```
chain length  count    note
1             91       independent run (no parent_run_id)
2             64       one stage-progression (e.g. execute → review.parent = execute.id)
3              3       continuation of a continuation
4              1       M5 DqF2 chain: W3tzS → Ec6ZS → WPRY0 → Ec6ZS → review
```

`parent_run_id` is **overloaded** in this schema: it carries both
(a) "this run is the next stage after that one" (63 occurrences — every successful review points to its execute parent), and
(b) "this run is a recovery continuation of that one" (5 occurrences — the actual provider-recovery chains).

Telling these apart requires inspecting `diagnostics.continuation_*` keys, which only the recovery variant populates. There's no clean `kind` enum on the join. (Finding F11.)

The 5 true recovery continuations:

| parent (failed)                              | child            | child outcome                          |
|----------------------------------------------|------------------|----------------------------------------|
| `DT7e7zLnjeXRVjoD0oeCF` (provider_unavailable, 61 s) | `wTLUauQCBofMahvoGIWJp` | ✅ complete (M2 platform, 819 s) |
| `NDnzafBuAelMHHP64vihg` (provider_unavailable, 55 s) | `8N7BtCjt7Sfn2JRipZzUS` | ✅ complete (M4 plan, 189 s) |
| `W3tzSfytM969ZqmfDvz2Y` (provider_unavailable, 9 s)  | `Ec6ZSCipMSKGAdlhfV88S` | ❌ provider_unavailable (998 s — work was done but classified as failure) |
| `Ec6ZSCipMSKGAdlhfV88S` (provider_unavailable, 998 s) | `WPRY0tliQVacWWH5krEWR` | ✅ complete (M5 runtime, 48 s, no real work to do) |
| `YYVSFAkwnNiJQkTVr4Zg7` (provider_unavailable, 439 s) | `rFyvnQpVmhMAYnaeIHwZC` | ✅ complete (M5 UI inspection, 220 s) |

Two notable absences: the two `invalid_result` review failures have **no recovery continuation** even though the failure kind is conceptually retryable (just a JSON parse). M3 Df4 was abandoned outright; M4 W6 had a fresh review spawned 24 minutes later with no `recovery_*` markers in its diagnostics, suggesting it was a manual or unrelated retrigger. (Finding F2.)


---

## 5. Per-task findings

This section narrates each root task's lifecycle. Lifecycles that hit no friction get a one-line entry; the interesting ones get a short narrative. All run/task IDs are clickable inside the SQLite DB via `sqlite3 ~/.worklab/worklab.db "SELECT * FROM task_runs WHERE id = '...'"`.

### 5.1 M0 architecture (`dNLIU1a3JS4kzJktaEjj7`) — clean
3 runs, 7 minutes, $1.48. Plan→execute→review, all `advance/advance/approve`. No friction.

### 5.2 M1 workspace shell (`lXxkiwZpF8aq4EWkbOjWT`) — clean
3 runs, 11 minutes, $4.19. UI engineer execute took 438 s for 69 turns to scaffold the shell. Reviewer approved in 98 s.

### 5.3 M1 verification & fixture foundation (`YtuwsahgV8nBdQocSOfZw`) — clean
3 runs, 10 minutes, $3.39. Standard plan/execute/review. No friction.

### 5.4 M2 modular persistence (`6FdEjoguViyBFQD7TaX7u`) — first provider error
4 runs, 19 minutes, $5.02.

The first execute (`DT7e7zLnjeXRVjoD0oeCF`) terminated after 61 s with `provider_unavailable / pi_stop_reason: error`. **Diagnostics confirm `continuation_scheduled: true, continuation_delay_ms: 33626, continuation_reason: provider_retryable`** — the harness's automatic retry behaved as designed. The continuation (`wTLUauQCBofMahvoGIWJp`) ran for 819 s, completed the work, and the reviewer approved. Total cost of the failure: 61 s wasted + ~34 s of backoff. **This is what good provider recovery looks like.**

### 5.5 M2 API and event interface (`uHy4CqZPSYmKTRcNctSj8`) — clean
3 runs, 15 minutes, $4.56. No friction.

### 5.6 M2 GitHub PR import (`3uN2OgiGSkRVko2z5L3UW`) — agent assignment anomaly
3 runs, 17 minutes, $5.17. **Execute ran on `github-dev` (not `benchmark-platform-engineer` or another benchmark-* agent).** That's the single appearance of `github-dev` on this project. The plan delegated to it deliberately (visible in the plan body's recommendation), so this isn't a bug — but it is a one-off that may make per-agent dashboards misleading and is worth deciding on policy: do specialised projects pin their agent fleet, or freely call out to general-purpose agents?

### 5.7 M2 PR import workspace (`kBzJvxzf2z8BydZMlvHHx`) — first user-cancel + first reviewer reject
6 runs, 38 minutes, $8.14.

Notable lifecycle:
1. `T7xjZctMOuNy1ze0POdHY` (plan) — **cancelled by user** at 18:25:35 (`api_cancel`, no reason).
2. Plan re-run 9 minutes later (18:34:01), succeeded.
3. UI engineer execute (`B4oWW37kL39UWo3M3QQlZ`) — 873 s, 130 turns, $5.17, marked `context_bloat` because `browser_take_screenshot` returned a payload large enough to risk exhausting context.
4. **Reviewer rejected** (`9ggyujj5kpmLfo7FEoxId`, 275 s, $0.56): `OperationalRow used but never defined — DatasetsPage and ActivityPage crash at runtime.` This is a real, well-articulated bug catch.
5. Execute 184 s (`3PfQJBBRr7JkBF7Ima7c8`) to fix the missing import.
6. Reviewer approved.

The reject loop worked exactly as designed. The user cancellation has no recorded `cancel_reason`, which limits how much we can learn from it.

### 5.8 M2 PR detail review surface (`gOjEtTec9vpOuMqOvp9Ku`) — first delegation
3 root runs + 4 children, 30 minutes, $7.66. Plan delegated to two children:
- `XVmd0cmU88HJE5EqNwgyt` "Implement PR detail review surface" → ui-engineer execute 483 s + reviewer 255 s.
- `ZTJl17S8kdLGUcLefFzFh` "QA PR detail review surface" → qa-reviewer in execute mode for 689 s + a meta-review of itself (33 s).

The "QA in execute" pattern (where the qa-reviewer is the *worker* for a delegated QA child) shows up here for the first time and recurs throughout M3+. See §6 F6.

### 5.9 M3 Pi-style runtime boundary (`XeD4c8peANDHKnprSUaXS`) — second user-cancel
3 root runs + 5 children, 49 minutes, $8.27.

Child `c4zfJDJNeu7B585hWlSeF` "M3 runtime boundary implementation" had its first execute attempt (`4zIZKWmMnQF5mzzr4i9xb`) cancelled by the user at 18:24:41 — **after running for 13 minutes and accumulating 885,261 event chars (`context_risk: high`).** The user's recorded reason: *"Commit repair requested before continuing shared project workdir."* So the operator noticed the agent was thrashing in a shared workdir and intervened. Re-run succeeded in 682 s, 79 turns. This is the only `cancelled_user` event with an explanatory message — it's instructive evidence that **operator visibility into context bloat is one click late**: the user only realised the agent was in trouble after the harness had spent 13 minutes and the user had to read transcripts to understand why.

### 5.10 M3 trace contracts (`ISl7sC6Ft1YLtCGNNUePR`) — biggest delegation fan-out
3 root runs + 8 children, 56 minutes, $20.46.

The biggest single delegation in the project. Children include `s8pSUbO4sSyBLlnFmjoU1` (runtime engineer execute: **1212 s, 167 turns, $9.11** — the second-most expensive single run on the project). `xnYFU5iubQjThOTfTxeit` (UI engineer execute, 797 s, $4.50) hit `context_bloat` from a `browser_take_screenshot`. All children completed clean. The parent's own execute was a 86-second sanity check after children finished.

### 5.11 M3 PR processing (`9W5fLBsap2Qw2fDix7R8l`) — orphaned `invalid_result`
3 root runs + 8 children, 1h31m, $24.55. **Most expensive root task.**

Three children of interest:
- `sM02OmZmOS5WPugxL15Qh` (M3 backend) — platform engineer execute 874 s, 99 turns, $5.43. Clean.
- `1XUjSRbh5lkGy7M6RfLmY` (M3 QA) — qa-reviewer execute **1251 s** (**longest run on the project**), 81 turns, $1.90. Clean approval.
- `Df4JbTXIfHHEldaGYiUlD` (M3 UI) — **the one orphaned `invalid_result`**:
  - Execute (`3mLLA4zMTO0NmdM44Fl4u`): 1062 s, $4.80. `advance`.
  - Review (`9ggyujj5kpmLfo7FEoxId`): 609 s, $1.86. **REJECT** for KeyValueList prop mismatch (real bug).
  - Re-execute (`wy3R8MBAzgM3IR2yQcZMM`): 167 s, $0.87. Fix landed as commit `636c6ea`.
  - Re-review (`01i6FI78ATSpwGYTahdrR`): **error / invalid_result**. The agent emitted text without the `worklab.v2` JSON envelope. `idle: 120000ms` warning fired before the parse error. After this, **no further runs** — yet the task ended in `done` with `failure_count = 0` and `rejection_streak = 0`. The agent's own comment trail says the fix worked ("Fixed and committed the blocker as 636c6ea"); the operator must have manually moved the task to `done` after seeing the work was already correct.

This is the cleanest single example of why F2 (`invalid_result` recovery is missing) matters: a substantively-good run was marked errored, the harness gave up, and the only reason the task didn't stay open forever is that the human knew the work was already shipped.

### 5.12 M3 Activity & trace inspection (`AOxLFGvr2aypKMupwr9WX`) — clean
3 root runs + 4 children, 31 minutes, $9.40. Clean delegate-and-converge.

### 5.13 M4 dataset module (`tYw4GF6f3oJEySgdUOHsw`) — clean provider recovery
4 root runs + 6 children, 28 minutes, $9.71. Plan failed once (`NDnzafBuAelMHHP64vihg`, provider_unavailable, 55 s) and was auto-recovered by `8N7BtCjt7Sfn2JRipZzUS` (189 s, $1.25). Same successful pattern as M2 §5.4.

### 5.14 M4 harness module (`hxrJLJLirAp1KROc7JpIl`) — second `invalid_result`, manual-style recovery
3 root runs + 6 children, 1h16m, $13.95.

The interesting child is `W6yaz4xdyx30df9OUX8MV` "M4 QA verify harness acceptance":
1. Execute (`cFIGsugNVSwEjLwdQhWFB`): qa-reviewer in execute mode, 366 s, $1.41. `advance`. Marked `context_bloat` from `browser_take_screenshot` (largest tool result: 1.44 MB).
2. Review (`YxLgWnIaRWboZZVjyGFQY`): 59 s, **error / invalid_result**.
3. **24-minute silence.**
4. Review (`WV2K36Fkk03LWo2c652kO`): 176 s, `approve`. Same `parent_run_id` as the failed review — but **no `recovery_*` or `continuation_*` keys in its diagnostics**. This was not the documented `schema_correction` recovery; it was either a manual UI re-trigger or an unrelated scheduler event.

So unlike M3 Df4, this task did get a successful re-review — but only because *something else* spawned it. This is feast-or-famine recovery: same failure kind, two outcomes, no transparency about why.

### 5.15 M5 matrix orchestration (`r27OgvezKFAa16ga1Np2i`) — clean
3 root runs + 6 children, 38 minutes, $15.14. The QA child caught a real Banner prop bug ("anti-scoring Banner description silently dropped due to wrong prop name"). Owner acknowledged and resolved. Clean.

### 5.16 M5 harness execution adapters (`1ihoRCNNET4kGuRPoHXCe`) — the 998 s ghost-success
3 root runs + 6 children, 32 minutes, $5.10.

Child `DqF2VoWfunNd15QXz3L0p`:
1. Execute (`W3tzSfytM969ZqmfDvz2Y`): 9 s, `provider_unavailable / pi_stop_reason: error`. `had_partial_progress: false`. Continuation scheduled in 33 s.
2. Continuation (`Ec6ZSCipMSKGAdlhfV88S`): **998 s, 129 turns, 149 tool_results, `had_partial_progress: true`. The agent ran the entire task — `git status`, file edits, tests, `journal_summary({ "Completed M5 runtime adapter execution/diff evidence implementation as commit 17c89b7" })`. Then it received `terminated` from the Codex provider and the harness classified the run as `provider_unavailable`.** Two warnings fired during the run: `context_bloat` (Read tool result 21 KB) and `idle` (no events for 120 s).
3. Continuation-of-continuation (`WPRY0tliQVacWWH5krEWR`): 48 s, `advance`. The agent observed that commit `17c89b7` was already in git, the tests passed, and emitted the structured result. Cheap, fast, but only because **the previous 998-second job had effectively finished**.
4. Review: approve.

Net cost: 9 s (first failure) + 998 s (ghost-success classified as failure) + 48 s (mop-up) + 118 s (review) ≈ 19 minutes of wall-clock for ~10 minutes of "real" work. This is the canonical example for R2.

### 5.17 M5 test inspection (`b6SbDV1hWnJ8C3CDMIALg`) — provider error, clean recovery
3 root runs + 5 children, 31 minutes, $5.49. UI engineer's first execute (`YYVSFAkwnNiJQkTVr4Zg7`) failed at 439 s with `provider_unavailable`. Continuation `rFyvnQpVmhMAYnaeIHwZC` succeeded in 220 s. Reviewer approved.

### 5.18 M6 readiness & operational settings (`Tf2pKb457mVhCU5cRNrH2`) — clean
3 root runs + 6 children, 39 minutes, $13.07. Clean delegate-and-converge.

### 5.19 M6 E2E V1 smoke (`NvWmwpAlPFJDVI0KT5C7D`) — atypical reviewer assignment
3 runs, 12 minutes, $3.13. The execute is **the qa-reviewer in execute mode** (no delegation; the smoke task is small enough to do directly), and **the review is `benchmark-product-lead`** rather than the qa-reviewer. This is the only review on the project not done by qa-reviewer. The plan presumably noticed that asking the QA agent to review the QA agent's own work would be a self-review and routed to the product lead instead. Worth checking that the routing logic is intentional, not accidental.

### 5.20 M6 final compliance audit (`uz4Xm3xfKLfs6wgkEEfAL`) — heaviest delegation
3 root runs + 6 children, 24 minutes, $22.43. **Most expensive root including children.** The three audit children together cost $19.92 (run `VjdareOAUmCn5BBLaxZgt` alone: $10.43, 1044 s, **221 turns**, the most-turns single run on the project). All three audit children clean, all approved.

### 5.21 M7A resource route model (`SKf1SsTTU3OUfv4MmNHH6`) — third user-cancel
4 runs, 49 minutes, $2.31. UI engineer execute (`H16I7AQGJzMJeK3AUsqVa`) was cancelled by the user at 08:01:49 after **13 minutes** (no recorded reason). 44 minutes later a clean execute completed in 203 s. The combination of 13 minutes wasted + 44 minutes of operator silence is curious — possibly the operator stepped away after cancelling.

### 5.22 M7B list/detail refactor (`85bLzge681cRDTFrEtC9Y`) — clean
3 root runs + 4 children, 36 minutes, $11.99. Notable child: `QNrmVW8FXbAZjmHCBfF4q` (M7B impl) ran 1042 s, 162 turns, $7.25 — the **third-largest single run on the project**.

### 5.23 M7C drill-in routes (`5OBnNTgqmefka1AzylT2x`) — first stale-cancel cluster
3 root runs + 4 children, 42 minutes, $11.84. Child `0ygqqmVKThm7Mvk2b1z1h` (QA M7C drill-in) had its first execute (`q8Rc38XnAzDwBGSagBgPY`) cancelled at 489 s with `cancelled_stale / coordinator_shutdown / "coordinator stopping"` and an `idle: 120000ms` warning. The retry succeeded in 512 s. ~8 minutes of work lost to the coordinator restart.

### 5.24 M7D mobile route QA (`7KhHThu5jryTAq91XzgIT`) — three stale-cancels, one provider error, all in one task
6 runs, 53 minutes, $6.79.

This is the noisiest task in the dataset, even though it eventually succeeded:

| run | mode | agent | duration | outcome | note |
|---|---|---|---:|---|---|
| `QAcRd6IsAv0lKDTtRkSHj` | plan | product-lead | 44 s | cancelled_stale | coordinator_shutdown |
| `sDG7sJzfze9pYqYaNop1f` | plan | product-lead | 68 s | ✅ advance | re-run |
| `gUO3vCN2Uelvs5GXtMrPh` | execute | qa-reviewer | 640 s | cancelled_stale | coordinator_shutdown, 6.1 MB event chars, idle warning |
| `vDrPeXVGFoW1DpxMlgHVW` | execute | qa-reviewer | 1015 s | ✅ advance | redo, even bigger context (13.4 MB!) |
| `QF2iCnxpC4OTbOT1HZaGc` | review | product-lead | 167 s | error / provider_unavailable | `last_tool_name: browser_navigate` |
| `oiMWm9qosfoSQSC1pr4zq` | review | product-lead | 392 s | ✅ approve | continuation succeeded |

The execute work was the qa-reviewer doing mobile QA — taking screenshots at 390/860/1280/1440 px viewports — which is the worst case for the playwright bloat issue (F1). The coordinator restart wasted 11 minutes; then the redo was even more bloated than the cancelled run. Then the review hit a Codex provider drop, recovered. ~$0 of cancelled and errored work was billed because Codex doesn't bill on `terminated` errors, but ~25 minutes of wall-clock was burned.


---

## 6. Cross-cutting findings

### F1 — `mcp__playwright__browser_take_screenshot` payloads dominate context-bloat warnings

**Observation.** 45 of 159 runs (28%) tripped the `context_bloat` warning. Of those, the largest single tool result on the project was **1,441,273 chars** of `mcp__playwright__browser_take_screenshot` output on `cFIGsugNVSwEjLwdQhWFB` (M4 QA). Other examples:

| run | tool | chars | run total event_chars |
|---|---|---:|---:|
| `cFIGsugNVSwEjLwdQhWFB` (qa-reviewer execute) | `mcp__playwright__browser_take_screenshot` | 1,441,273 | 4,082,689 |
| `vDrPeXVGFoW1DpxMlgHVW` (qa-reviewer execute, M7D) | `mcp__playwright__browser_take_screenshot` | 1,331,034 | **13,389,923** |
| `4kxoIwOPnkCbsK8wo6Fyi` (qa-reviewer execute) | `mcp__playwright__browser_take_screenshot` | 1,123,444 | **13,903,981** |
| `zqcbJGivjoJdxAtubJ1xn` (qa-reviewer execute) | `mcp__playwright__browser_take_screenshot` | 1,099,193 | 3,377,866 |
| `9ePNTHYGNtVwzIaQ6p9Jg` (qa-reviewer review) | `mcp__playwright__browser_take_screenshot` | 993,551 | 2,201,746 |

A 1.4 MB tool result is almost certainly a base64-encoded screenshot returned in the `tool_result.content`. Every byte is paid for at provider input rates (Sonnet 4.6 input is $3/MTok), every byte is part of the model's context window, and every byte is re-shipped on every subsequent turn until compaction.

**Impact.**
- The qa-reviewer accounts for **24 of 29 idle warnings** and **19 of 45 context_bloat warnings**, almost entirely from this one tool.
- The qa-reviewer has the **only** two `invalid_result` errors in the dataset; both happened on review runs that had taken multiple browser_snapshots first.
- The largest qa-reviewer execute (`4kxoIwOPnkCbsK8wo6Fyi`, 13.9 MB total events) burned $0 because Sonnet's caching absorbed it (cache_read_tokens: 121M project-wide), but on a model without aggressive caching this would be many tens of dollars per run.

**Root cause hypothesis.** The Playwright MCP returns image data inline in `tool_result.content` (likely as `image` content blocks containing base64). Worklab's `pi-bridge.js` and `tools/index.js` warn but do not intervene. The harness has the data to decide ("this tool result is huge"); it just doesn't act.

**Recommendation R1 (Blocking).** Three options, in order of impact:

1. **Cap or sidestep the screenshot tool at the harness level.** In `src/agent/tools/pi-bridge.js`, intercept `tool_result` blocks whose `tool` matches a configured "binary-bloat" allowlist (`mcp__playwright__browser_take_screenshot`, `mcp__playwright__browser_snapshot`) and rewrite the content to `{ type: "text", text: "Screenshot saved to <path>; size <N> bytes" }`. Save the actual bytes to disk under `~/.worklab/runs/<run_id>/tool-output/`, expose via a path the agent can re-read. This converts the bloat into addressable artifacts.
2. **Configure the playwright MCP server to write screenshots to disk and return paths.** Cleaner if the MCP supports it, but requires touching the MCP config in `~/.worklab/agents/benchmark-qa-reviewer/mcp.json` (or wherever the Playwright server is wired). Less general — only fixes one tool.
3. **Add a hard ceiling in `src/ai/result/contract.js` or `src/agent/compaction.js`** so any single tool result over (say) 256 KB is replaced with `{kind: "tool_result_truncated", ...}` plus a stored full copy. This is the safety net that catches future tools we haven't whitelisted.

R1 should be (1)+(3): explicit handling for the known offender plus a global safety net.

---

### F2 — `invalid_result` on review does not auto-recover

**Observation.** Two `invalid_result` review errors in the dataset:

| run | task | result | follow-up |
|---|---|---|---|
| `01i6FI78ATSpwGYTahdrR` | M3 Df4 (PR processing UI) | `final text is not JSON` after 304 s of work | **None.** Task moved to `done` with no successful re-review (operator must have moved by hand). `failure_count = 0`. |
| `YxLgWnIaRWboZZVjyGFQY` | M4 W6 (harness QA) | `final text is not JSON` after 59 s | A *different* review (`WV2K36Fkk03LWo2c652kO`) ran 24 minutes later and succeeded. **No `recovery_*` or `continuation_*` markers in its diagnostics.** |

The source-code exploration done at the start of this audit suggested a `schema_correction` continuation flow exists for `invalid_result` failures (recovery continuation with `reason = "schema_correction"` plus a guidance comment to re-emit valid `worklab.v2` JSON). That flow either does not exist in the running system, or it is not being triggered for these reviewer failures. Diagnostic state is the same on both failures (`{warning_count: 2, failure_kind: invalid_result}` plus a `review_result_parse` warning), and neither has a `continuation_scheduled: true` field that was present on every `provider_unavailable` failure. Confirming whether the flow is implemented is the first step; if it is, finding why it doesn't fire here is the second.

**Impact.** Silent abandonment. The user has to notice the orphan and either retry it or move the task by hand. M3 Df4 is exactly this case: the work was correct (commit `636c6ea`), the agent's text response was substantively right, the only failure was the JSON envelope, and the harness gave up.

**Root cause hypothesis.** Either (a) `validateWorklabResultSemantics()` rejects pure-text reviewer output and the failure handler in `src/coordinator/watcher/run-handler.js` does not classify `invalid_result` as a retryable failure, or (b) the schema-correction continuation is implemented but is conditionalised on something the QA reviewer doesn't satisfy (e.g., `pi-sdk` provider only, or only on `execute` mode). Worth checking `src/coordinator/watcher/failure-classifier.js` and `src/coordinator/watcher/run-handler.js` for `invalid_result` branches.

**Recommendation R3 (High).** Two paths, do both:

1. **Robust JSON extraction.** Before failing a run with `invalid_result`, run the final text through a tolerant extractor: strip code fences, find the largest balanced `{...}` substring, parse, validate. Most "final text is not JSON" failures we see in this dataset are an agent forgetting the envelope or wrapping it in markdown — both fixable with a 30-line parser. Owner: `src/ai/result/contract.js` (add `parseWorklabResultLenient`), wire into `src/worker.js` and `src/agent/tools/index.js` before classifying as failure.
2. **Implement a real schema_correction continuation** that mirrors the provider-recovery continuation: re-spawn the run with the same agent, the same transcript snapshot, and a system prompt prefix saying "Your previous run produced text that wasn't valid worklab.v2 JSON. Re-emit your conclusion as a JSON envelope only — no markdown, no commentary." Use `parent_run_id` to chain, set `diagnostics.continuation_reason = "schema_correction"`, count against the same continuation_limit as provider recovery. Owner: `src/coordinator/task-watcher.js` and `src/coordinator/watcher/run-handler.js`.

---

### F3 — Provider-recovery treats partial success as failure

**Observation.** `Ec6ZSCipMSKGAdlhfV88S` (M5 DqF2, the 998 s run) was a *recovery continuation* that ran for 16 minutes, called 149 tools, made 129 turns, ran `git status`, ran the test suite, made commit `17c89b7`, called `journal_summary({"text": "Completed M5 runtime adapter execution/diff evidence implementation as commit 17c89b7..."})`, received `{"ok": true}` from the journal tool — and immediately got `terminated` from Codex. The harness classified the run as `provider_unavailable` and scheduled another continuation, which was a 48-second sanity check that observed the work had been done.

`error_details.had_partial_progress = true`, `tool_results_seen = 149`, `last_text_excerpt = "!"`, `last_tool_name = "journal_summary"`. Every signal the harness has access to says "this run finished its work." None of those signals are used to decide whether to schedule another retry.

**Impact.** Cost-wise this is negligible (Codex doesn't bill `terminated` runs). But the harness has now spawned a **third continuation** and is at depth 2/5 of its `continuation_limit`. If a future task drops two providers in a row mid-success, we will hit the limit on a *finished* task and surface a spurious failure.

This pattern also generates noise in the operator's incident view: an "error" run that did the entire job. It conditions the operator to ignore `provider_unavailable` errors, which is exactly the wrong reflex.

**Root cause hypothesis.** `src/ai/failure.js → classifyFailure()` reads `error_details.had_partial_progress` but doesn't act on it. The continuation scheduler in `src/coordinator/watcher/run-handler.js` doesn't inspect the failed run's transcript for `journal_summary` calls or git mutations before deciding to retry. The `worklab_result` contract has no "intermediate success" state.

**Recommendation R2 (High).** Two related changes:

1. **Salvage the partial result.** When a run errors with `had_partial_progress: true` and `last_tool_name == "journal_summary"`, treat it as `decision: needs_finalisation`, not `provider_unavailable`. Spawn a continuation whose system prompt is "Your previous run completed work and called `journal_summary` but the provider connection dropped before you could emit the worklab.v2 JSON. Verify the work is complete and emit the envelope." This is what the human operator does in their head every time they see this pattern.
2. **Treat "agent declared completion + clean worktree + tests passing" as success even on terminated runs.** When the harness sees a clean worktree and a recent commit by the agent, an `error / provider_unavailable` should be elevated to a manual-review state (new failure_kind: `terminated_after_completion` or similar) rather than silently retried. Owner: `src/ai/failure.js` (new sub-kind), `src/coordinator/watcher/failure-classifier.js` (new branch), `src/coordinator/watcher/run-handler.js` (don't retry; surface to user).

---

### F4 — `failure_count`/`rejection_streak` reset on success destroys the audit trail

**Observation.** All 59 task rows on this project have `failure_count = 0` and `rejection_streak = 0`. The audit-doc-referenced state machine treats these as "current attempt" counters, which is fine for triggering escalation, but means the `tasks` table alone tells you nothing about what happened to a task across its life. We had to reconstruct from `task_runs` to see that:

- `kBzJvxzf2z8BydZMlvHHx` had a reviewer reject midway → fc = 0 today.
- `Df4JbTXIfHHEldaGYiUlD` had an `invalid_result` and a manual recovery → fc = 0 today.
- `7KhHThu5jryTAq91XzgIT` had 3 stale-cancels and 1 provider error → fc = 0 today.

The state machine is correct for routing decisions, but the operator dashboard is missing the "did anything go wrong on the way to done" view.

**Impact.** Hard to triage post-mortem. Hard to prioritise improvements. Hard to alert on patterns ("which tasks needed >1 attempt this week?").

**Recommendation R4 (Medium).** Add cumulative counters that are *not* reset:
- `tasks.lifetime_failure_count` (or compute on the fly from `task_runs`).
- `tasks.lifetime_rejection_count`.
- A computed view `task_health` that exposes `last_failure_kind`, `last_failed_run_id`, `total_recovery_continuations`, `peak_context_risk`.

Owner: `src/core/db/schema/`, `src/core/db/queries/tasks.js`. UI: surface in the task list/detail.

---

### F5 — `cancelled_stale` is overloaded

**Observation.** 3 of 4 `cancelled_stale` events have `cancel_initiator = "coordinator_shutdown"` and `cancel_reason = "coordinator stopping"`:

| run | cancelled at | duration | task |
|---|---|---:|---|
| `q8Rc38XnAzDwBGSagBgPY` | 09:48:31 | 489 s | M7C QA drill-in |
| `QAcRd6IsAv0lKDTtRkSHj` | 10:01:19 | 44 s | M7D plan |
| `gUO3vCN2Uelvs5GXtMrPh` | 10:13:24 | 640 s | M7D execute |

These are not "stale" runs that the reconciler killed — they are healthy runs that the coordinator killed because it was shutting down. The `cancelled_stale` failure_kind is the only signal currently available to the operator, and it implies a bug in the worker rather than a deliberate coordinator restart.

The fourth cancelled_stale event would need additional code-side investigation, but the timing pattern (all three within 33 minutes) strongly suggests a single `worklab restart` invocation that bounced the coordinator and lost ~1100 s of execute work.

**Impact.**
- Operator sees errors that are actually their own restart.
- Workers that were minutes from completing are killed instead of allowed to drain.
- Recovery retries spawn from scratch, replaying all the context-bloat costs.

**Recommendation R5 (Medium-High).** Three related changes:

1. **Distinguish `cancelled_shutdown` from `cancelled_stale`** in `src/ai/failure.js → FAILURE_KINDS`. The state machine and UI should treat them differently: shutdown is "we did this", stale is "the worker was wedged".
2. **Drain in-flight workers on coordinator shutdown.** In `src/coordinator/coordinator.js` and `src/cli/start.js`, send a graceful-stop to each active worker, give it (configurable) `worklab_drain_timeout_ms` (e.g. 60s) to emit a partial worklab_result before SIGTERM. Currently the shutdown path appears to SIGTERM workers immediately.
3. **Resume snapshots from drained workers.** If a worker was making progress (tool_results_seen > N) when shutdown happened, persist enough state to resume from where it left off, not from the start. Owner: `src/agent/transcript.js`, `src/coordinator/watcher/run-handler.js`.

---

### F6 — Two-track reviewer pattern doubles the QA cost

**Observation.** When a plan delegates, it commonly creates **two children**: an implementation child (e.g. `Implement benchmark test inspection comparison view`) **and** a "QA verify" child (e.g. `QA review benchmark test inspection view`). The QA child has the qa-reviewer as its *executor*, takes ~5–20 minutes to do a manual checklist + Playwright walkthrough, then has the qa-reviewer *also* meta-review its own output. Then the parent task does its **own** review-stage run — a third pass.

So a single milestone like "M5 test inspection view" actually goes:

```
parent.plan(product-lead) → delegate
  ↓
  child_impl.execute(ui-engineer)         } 1058 s, $4.13
  child_impl.review(qa-reviewer)          }  86 s, $0.20
  ↓
  child_qa.execute(qa-reviewer)           } 470 s, $1.32  ← duplicates parts of the impl review
  child_qa.review(qa-reviewer)            }  95 s, $0.19  ← qa-reviewer reviewing its own QA
  ↓
parent.execute(ui-engineer)               }  60 s, $0.36  ← collation
parent.review(qa-reviewer)                }  86 s, $0.20  ← third QA pass
```

That's 3 QA passes for one work item: child_impl.review + child_qa.execute + parent.review. The cost is moderate (qa-reviewer averages $0.55/run thanks to caching) but the *time* is meaningful — the parent can't progress until both children complete.

**Impact.** Wall-clock latency: M3, M4, M5, M6, M7B, M7C all show this pattern. The `awaiting_children` window is dominated by waiting for the QA child, not the impl child. Duplicate work: the QA child often re-runs the same Playwright walkthrough as the impl review. Recursive review: the qa-reviewer reviewing qa-reviewer is mechanical.

**Root cause hypothesis.** The product-lead's planner prompt encourages "delegate impl + QA in parallel" (per the plan_body content I sampled). But the parent task still has its own review stage by default. There's no explicit convention that a delegation pattern with a `*-qa-*` child means "skip the parent.review."

**Recommendation R6 (Medium).** Two options, prefer (1):

1. **Plan-driven join policy.** Allow the plan to declare `parent.skip_review = true` if a `qa` child exists. Or, more cleanly, allow the planner to declare "this delegation produces its own QA — parent's review is just a no-op approval." Implement in `src/core/state-machine.js` plus a new field on the `tasks` row.
2. **Deduplicate the QA child's meta-review.** The pattern of `qa-reviewer doing execute then qa-reviewer reviewing that execute` is structurally never going to reject. Auto-approve (no LLM call) when the executor and reviewer are the same agent and the executor's decision was `advance`/`approve`. Saves ~$0.20 and ~90 s per QA child.

---

### F7 — High idle warning rate on the QA reviewer

**Observation.** 24 of 29 `idle: No worker events for 120000ms` warnings come from the qa-reviewer (claude). Distribution by agent:

```
qa-reviewer        24
ui-engineer         3
runtime-engineer    1
platform-engineer   1
product-lead        0
```

Two-minute idle windows are the harness's "uh oh" signal. They almost always coincide with `context_bloat` events, suggesting the model is spending those two minutes paging through 1+ MB of base64 image data before it can take its next action.

**Impact.** Looks scary in the UI ("this run is stuck"). Conditions operators to mistake healthy-but-slow runs for hung ones — they then cancel them, generating spurious `cancelled_user` events.

**Recommendation R7 (Medium).** Two things, do both:

1. **Tune the idle threshold per agent / per provider** (currently a global 120 s). Claude with playwright-heavy turns should get 240 s+; codex turns are usually faster and 120 s is appropriate. Owner: `src/core/runtime` settings + `src/coordinator/watcher/`.
2. **Show which tool the agent is processing during idle** in the UI. The worker knows because the previous event was `tool_result`; surface that in the warning ("idle, last tool: `mcp__playwright__browser_take_screenshot`"). This makes "model is digesting a screenshot" obviously different from "worker is genuinely hung." Owner: `src/api/sse.js` + UI.

This becomes nearly free if F1's screenshot fix lands, but the heuristic is still worth keeping.

---

### F8 — Continuation-of-continuation chains aren't bounded by *real* work

**Observation.** The `continuation_limit` is 5, the `continuation_depth` increments each time. But "depth" in the M5 DqF2 case includes the 998-s ghost-success that did real work. That run happens to be at depth 1 of 5; if the same scenario played out again, depth would climb to 2 or 3 against a task that is functionally complete after depth 1.

`continuation_root_run_id` exists in diagnostics but is not consulted by the limit check; the limit just looks at `continuation_depth`.

**Impact.** Today, never bites. Tomorrow, a flaky upstream provider plus a long task that completes on retry-1 means we burn the budget on continuations that the agent doesn't actually need. The budget is meant to protect against infinite-loop recovery, not to gate rapid completion.

**Recommendation R8 (Low).** Decouple "did the agent make progress" from "depth of the continuation tree". When a continuation completes the work (clean worktree, journal_summary, agent committed), reset the continuation budget for that root. Owner: `src/coordinator/watcher/run-handler.js`. Closely related to R2 and arguably folded into it.

---

### F9 — One-off agent assignment (`github-dev`) escapes the agent fleet model

**Observation.** Every run on this project is by a `benchmark-*` agent except `ta7utjYSP2rB` (M2 GitHub PR import execute), which used `github-dev`. The plan deliberately recommended the github-dev agent ("This is a self-contained mechanical import; the github-dev agent has the right MCP allowlist") — but if you are operating a project with a curated agent fleet, having a planner pull in agents from the global registry undermines the fleet curation.

**Impact.** Token cost reporting per agent is misleading (one-off agents skew per-agent averages). Audit / compliance review of "what agents touched this project" is incomplete unless you read every plan body.

**Recommendation R9 (Low).** Make agent-fleet enforcement a project setting: `project.allowed_agents = [...]` (default: any). When a plan delegates to an agent outside the allowlist, fail-fast or require an operator-confirmation flag. Owner: `src/core/db/queries/projects.js` (new column), `src/coordinator/watcher/delegation-handler.js` (validation), UI (project settings page).

---

### F10 — User cancellations carry almost no metadata

**Observation.** 3 `cancelled_user` runs:

| run | task | duration before cancel | cancel_reason |
|---|---|---:|---|
| `T7xjZctMOuNy1ze0POdHY` | M2 PR import plan | 136 s | _none_ |
| `4zIZKWmMnQF5mzzr4i9xb` | M3 runtime impl | 779 s | "Commit repair requested before continuing shared project workdir" |
| `H16I7AQGJzMJeK3AUsqVa` | M7A resource route | 778 s | _none_ |

The one cancellation that recorded a reason ("Commit repair requested...") is by far the most useful for understanding the operator's intent. The other two leave us guessing — was the operator unhappy with the direction? Did they want to change the plan? Did they realise the agent was looping?

**Impact.** Patterns we can't see from data become invisible. We can't tell the difference between "user cancelled because plan was wrong" (improve the planner) and "user cancelled because agent was thrashing" (improve the watcher).

**Recommendation R10 (Low–Medium).** Make `cancel_reason` required (or at minimum, a single-select picklist: "wrong direction" | "agent stuck" | "context bloat" | "other"). Owner: API `POST /tasks/:id/cancel` in `src/api/routes/tasks.js`, UI cancellation modal.

---

### F11 — `parent_run_id` is overloaded between "next stage" and "recovery continuation"

**Observation.** Of 67 runs with a non-null `parent_run_id`, 63 are stage-progressions ("review.parent = execute") and 4–5 are real recovery continuations. The only way to distinguish them is to inspect `diagnostics.continuation_reason`, which exists on the recovery variant.

**Impact.** Anyone querying "show me the history of recoveries" via SQL has to join into the JSON `diagnostics` blob. Anyone looking at the `parent_run_id` column alone gets misleading chain analysis. Our own `analyze.py` initially over-counted the recovery continuations because of this.

**Recommendation R11 (Low).** Add a column `task_runs.parent_relationship` with values `stage_progression | recovery_continuation | manual_retry`. Backfill from `diagnostics.continuation_*`. Owner: `src/core/db/schema/`, `src/core/db/queries/runs.js`.

---

### F12 — Cache-hit ratios are excellent — when caching is alive

**Observation.** Aggregate cache_read tokens: **279 million**. Aggregate live input tokens: **10 million**. Cache hit ratio overall: **96.6%**. By agent:

```
qa-reviewer       99.9%
ui-engineer       95.6%
runtime-engineer  95.4%
platform-engineer 94.9%
product-lead      92.2%
```

This is a real success — Worklab is squeezing every available cache hit out of the long sessions. The cache savings are why $213.51 looks reasonable for what would otherwise be a four-figure project.

But: caching is per-provider-session. Recovery continuations and `cancelled_stale` reruns lose the session and pay full price for the first turn. The 998 s ghost-success run paid $0 (Codex doesn't bill terminated), but its replacement `WPRY0tliQVacWWH5krEWR` paid $0.36 and would have been ~$0.04 if cache had been preserved.

**Recommendation R12 (Medium).** Investigate persisting `provider_session_id` across recovery continuations. The `task_runs.provider_session_id` column exists; we just don't always reuse it. Owner: `src/ai/providers/{pi-sdk,claude-sdk,codex-app}.js`.


---

## 7. Failure-mode deep dives

### 7.1 `provider_unavailable` (n=6, all Codex)

Every `provider_unavailable` event came from the codex provider (almost certainly via `pi-sdk.js`, given the project's memory pin that codex agents flow through pi-sdk). All six share:

- `error_text: "terminated"` (the generic Codex disconnect message)
- `pi_stop_reason: "error"` (no `pi_error_code`, no `pi_request_id` — there's nothing in the diagnostics that lets us correlate to a server-side incident)
- `retryable_provider_error: true`
- `continuation_scheduled: true` with an exponential-backoff delay (33 s on first retry, 63 s on chained retry)

Inventory:

| run_id | task | depth | duration | partial progress | outcome of continuation |
|---|---|---:|---:|---|---|
| `DT7e7zLnjeXRVjoD0oeCF` | M2 platform | 0 | 61 s | no | succeeded (819 s) |
| `NDnzafBuAelMHHP64vihg` | M4 plan | 0 | 55 s | no | succeeded (189 s) |
| `W3tzSfytM969ZqmfDvz2Y` | M5 runtime | 0 | 9 s | no | failed-but-finished (Ec6ZS, 998 s) |
| `Ec6ZSCipMSKGAdlhfV88S` | M5 runtime | 1 | 998 s | **yes** | succeeded (48 s, work was done) |
| `YYVSFAkwnNiJQkTVr4Zg7` | M5 UI inspection | 0 | 439 s | no | succeeded (220 s) |
| `QF2iCnxpC4OTbOT1HZaGc` | M7D review | 0 | 167 s | yes | succeeded (392 s) |

**Patterns:**
- 4 of 6 happened in the **first 60 s** of a run — a fast-fail Codex disconnect.
- 2 of 6 happened **after substantial progress** (`Ec6ZS` at 998 s after committing work; `QF2i` at 167 s after 18 turns of browser_navigate). These are F3 candidates.
- All 6 recovered eventually.
- The `provider_error_subkind: "terminated"` is the only diagnostic; we don't have HTTP status, server timestamp, or request id. **This is a gap.**

**Concrete recommendations:**

- Capture `pi_request_id` and `pi_error_code` in `pi-sdk.js` even when the connection is terminated (some Codex errors include them in the SSE error frame). Owner: `src/ai/providers/pi-sdk.js`.
- If we can identify a class of "Codex terminated immediately on connect" (the 4 fast fails at 9–61 s), we may be able to add a pre-flight ping or session-warmup. Worth correlating timestamps against any Codex-side incident reports.
- For the long-progress fails (F3), see R2.

### 7.2 `invalid_result` (n=2, both QA reviewer / claude)

Both reviews emitted final text that wasn't a `worklab.v2` JSON envelope. The agent's text response was substantively a review (markdown with sections like "**VERDICT:** approve" or "**Approve.** Independent verification..."), but the harness needs strict JSON. This is the F2 finding above.

Notable shared properties:

- Both runs took multiple Playwright screenshots before the parse failure.
- Both runs emitted `idle: 120000ms` warnings *before* the parse error — the model was thinking for a long time, then emitted a long text reply, then the worker tried to parse and failed.
- Both ran `mcp__playwright__browser_take_screenshot` with the largest tool result in the four-figure-KB range (35 KB and 1.4 MB respectively).

**Recommendations:** see R3.

### 7.3 `cancelled_stale` (n=4 across 3 runs distinguished by task)

Of the 4 `cancelled_stale` events, **3** have explicit `cancel_initiator = coordinator_shutdown` and `cancel_reason = "coordinator stopping"`. This is F5 — these are not stale-reconciliation events, they are coordinator restarts.

The fourth event needs further investigation; the diagnostics on it would show whether `reconcileStaleRunningRuns()` was the trigger.

Cluster timing: all 3 confirmed shutdowns happened within a 33-minute window on the morning of May 2 (09:48 → 10:13 → 10:01). Given the project was actively in use that morning, the most likely cause is a `worklab restart` invocation — possibly to apply a config or settings change. There's no automation/cron in the data for this window.

**Recommendations:** see R5 (split the failure_kind, drain on shutdown, allow resume).

### 7.4 `cancelled_user` (n=3)

Three user cancellations. The pattern:

| run | when | how late | what we know |
|---|---|---:|---|
| `T7xjZctMOuNy1ze0POdHY` (M2 plan) | 18:25:35 | 136 s in | _no reason_ — operator possibly noticed a wrong-direction plan; re-plan succeeded 11 minutes later |
| `4zIZKWmMnQF5mzzr4i9xb` (M3 runtime) | 18:24:41 | 779 s in | "Commit repair requested before continuing shared project workdir" — operator noticed agent was thrashing in the shared workdir |
| `H16I7AQGJzMJeK3AUsqVa` (M7A UI) | 08:01:49 | 778 s in | _no reason_ — operator stepped away for 44 min before retry |

Two of three cancellations happened ~13 minutes into the run. Combined with F1 (context bloat from screenshots) and F7 (idle warnings), this paints a clear picture: **operators cancel runs that look stuck even when those runs are healthy-but-bloated**.

**Recommendations:** see R10 (record cancel reasons), F1/F7 (reduce the "looks stuck" surface area).

---

## 8. Per-agent profiles

### 8.1 `benchmark-qa-reviewer` (claude / claude-sonnet-4-6)

| metric | value |
|---|---|
| Runs | 78 |
| Success rate | 94.9% (74 ✓ / 2 error / 2 cancelled) |
| Modes | 60 review, 18 execute |
| Decisions | 62 approve, 10 advance, 2 reject |
| Failure kinds | 2 invalid_result, 2 cancelled_stale |
| Duration | avg 229 s, p50 113 s, p90 533 s, max 1252 s |
| Turns | avg 37, p50 28, p90 77, max 134 |
| Total cost | $42.81 ($0.55/run) |
| Cache hit ratio | 99.9% |

**Strengths.** Cheap per run, very high cache hit ratio, found 2 real bugs, never erred on the actual judgement (decisions were always defensible).

**Weaknesses.** Both `invalid_result` errors. 24 of 29 idle warnings. Heavy context bloat from Playwright. The "QA in execute" pattern means it does double duty as worker + reviewer (F6).

**Recommendations.** R1 (screenshot bloat), R3 (invalid_result recovery), R6 (QA execute deduplication), R7 (per-agent idle thresholds).

### 8.2 `benchmark-product-lead` (codex / gpt-5.5)

| metric | value |
|---|---|
| Runs | 32 |
| Success rate | 87.5% (28 ✓ / 2 error / 2 cancelled) |
| Modes | 27 plan, 3 review, 2 execute |
| Decisions | 14 delegate, 12 advance, 2 approve |
| Failure kinds | 2 provider_unavailable, 1 cancelled_user, 1 cancelled_stale |
| Duration | avg 177 s, p50 181 s, p90 278 s, max 392 s |
| Turns | avg 26, p50 23, p90 49, max 68 |
| Total cost | $34.08 ($1.07/run) |
| Cache hit ratio | 92.2% |

**Strengths.** Plans are short and decisive. Delegates roughly half the time (14/27 plans). Good plan→outcome alignment — almost no mid-execute pivots.

**Weaknesses.** Plans are dense ($1.07/run avg, mostly going into reading the existing repo). The one cancelled_user happened on a plan run — possible signal that the plan was off-direction.

**Recommendations.** Marginal — R12 (cache reuse on continuations) and R10 (cancel reasons) would help but no agent-specific work needed.

### 8.3 `benchmark-ui-engineer` (codex / gpt-5.5)

| metric | value |
|---|---|
| Runs | 23 |
| Success rate | 91.3% (21 ✓ / 1 error / 1 cancelled) |
| Modes | 23 execute |
| Decisions | 21 advance |
| Failure kinds | 1 provider_unavailable, 1 cancelled_user |
| Duration | avg 493 s, p50 483 s, p90 890 s, max 1062 s |
| Turns | avg 72, p50 76, p90 129, max 162 |
| Total cost | $63.69 ($2.77/run) — **largest spender** |
| Cache hit ratio | 95.6% |

**Strengths.** Reliably ships UI work. The reject loop on M2 PR import (5.7) was caught and fixed in one cycle. Plenty of high-turn runs that completed without timing out.

**Weaknesses.** Large per-run cost. Many `context_bloat` warnings from large `Read` tool results — the agent reads a lot of files. The cancelled_user (M7A) ran for 13 minutes before the operator pulled the plug.

**Recommendations.** R1 if it does Playwright work (some of its runs do). Possibly an agent-level prompt tweak: "prefer targeted greps over broad reads" — but this is a soft fix.

### 8.4 `benchmark-platform-engineer` (codex / gpt-5.5)

| metric | value |
|---|---|
| Runs | 12 |
| Success rate | 91.7% (11 ✓ / 1 error / 0 cancelled) |
| Modes | 12 execute |
| Decisions | 11 advance |
| Failure kinds | 1 provider_unavailable |
| Duration | avg 533 s, p50 634 s, p90 875 s, max 927 s |
| Turns | avg 74, p50 71, p90 125, max 147 |
| Total cost | $41.55 ($3.46/run) — **highest avg/run** |
| Cache hit ratio | 94.9% |

**Strengths.** Most consistent per-run completion. No cancellations. Big chunky changes ($5+ runs are routine).

**Weaknesses.** Highest avg cost per run. The one provider_unavailable was the M2 first-attempt fail (5.4) which auto-recovered cleanly.

**Recommendations.** None agent-specific. The cost is justified by the work.

### 8.5 `benchmark-runtime-engineer` (codex / gpt-5.5)

| metric | value |
|---|---|
| Runs | 13 |
| Success rate | 76.9% (10 ✓ / 2 error / 1 cancelled) |
| Modes | 13 execute |
| Decisions | 10 advance |
| Failure kinds | 2 provider_unavailable, 1 cancelled_user |
| Duration | avg 413 s, p50 125 s, p90 1043 s, max 1212 s |
| Turns | avg 60, p50 25, p90 221, max 221 |
| Total cost | $27.36 ($2.10/run) |
| Cache hit ratio | 95.4% |

**Strengths.** Bimodal distribution: many short runs (collation/glue work) plus a handful of very heavy implementation runs (the 1212 s, 167-turn `s8pSUbO4sSyBLlnFmjoU1` and 1043 s, 221-turn `VjdareOAUmCn5BBLaxZgt` audits). Both biggest runs completed cleanly.

**Weaknesses.** **Lowest success rate on the project** (77%). Two provider errors and a user-cancel on `4zIZKWmMnQF5mzzr4i9xb` (the "shared workdir" cancel). The 998 s ghost-success (F3) is on this agent.

**Recommendations.** F3 is the big one (R2). The shared-workdir issue from M3 is a process problem (the agent was running against `~/Automattic_Repositories/A-Benchmark-2` which other agents also touched) — worth considering per-run ephemeral worktrees for runtime-engineer specifically.

### 8.6 `github-dev` (codex / gpt-5.5) — one-off

1 run, 750 s, $4.02, 78 turns, success. This is the M2 GitHub PR import (5.6). Nothing to recommend agent-side, but see F9 / R9 about agent fleet enforcement.


---

## 9. Recommendations — prioritised, with affected files

Severity rubric:
- **Blocking** — silent data loss / silent task abandonment / dominant cost driver. Fix first.
- **High** — repeat user-visible friction; users intervene every time it happens.
- **Medium** — quality-of-life or operator confusion; one-time impact each.
- **Low** — polish, instrumentation, future-proofing.

### Harness changes (code under `src/`)

| ID  | Sev | Title | Affected files | Rough effort |
|-----|-----|-------|----------------|--------------|
| R1  | **Blocking** | Cap `playwright_browser_take_screenshot` payloads in the harness; persist to disk and substitute a path reference. Add a global per-tool-result size ceiling as a safety net. | `src/agent/tools/pi-bridge.js`, `src/agent/tools/index.js`, `src/agent/compaction.js`, `src/ai/result/contract.js` (or new `src/agent/tool-bloat.js`) | 1–2 days |
| R2  | **High** | Treat `provider_unavailable` continuations with `had_partial_progress` + final `journal_summary` as **needs-finalisation**, not errors. Salvage the partial result; surface a distinct UI state. | `src/ai/failure.js` (new sub-kind), `src/coordinator/watcher/failure-classifier.js`, `src/coordinator/watcher/run-handler.js`, optionally `src/ai/result/contract.js` (intermediate-success state) | 2–3 days |
| R3  | **High** | Make `invalid_result` review failures recover. (a) Lenient JSON extractor before failing the run. (b) `schema_correction` continuation that re-spawns the run with a "emit JSON only" prompt. | `src/ai/result/contract.js` (lenient parser), `src/worker.js`, `src/coordinator/task-watcher.js`, `src/coordinator/watcher/run-handler.js` | 1–2 days |
| R5  | **Medium-High** | Distinguish `cancelled_shutdown` from `cancelled_stale`. Drain in-flight workers on coordinator shutdown with a configurable timeout; allow resume from drained transcript. | `src/ai/failure.js`, `src/coordinator/coordinator.js`, `src/cli/start.js`, `src/coordinator/watcher/run-handler.js`, `src/agent/transcript.js` | 2–4 days |
| R4  | Medium | Cumulative failure / rejection counters that don't reset on success. Computed `task_health` view. | `src/core/db/schema/`, `src/core/db/queries/tasks.js`, UI tasks list/detail | 1 day |
| R12 | Medium | Persist `provider_session_id` across recovery continuations to preserve cache. | `src/ai/providers/{pi-sdk,claude-sdk,codex-app}.js`, `src/coordinator/watcher/run-handler.js` | 1–2 days |
| R6  | Medium | Plan-driven join policy: allow plan to declare `parent.skip_review` when a QA child exists. Auto-approve QA-child meta-reviews when executor == reviewer. | `src/core/state-machine.js`, `src/core/db/schema/` (new column), `src/coordinator/watcher/delegation-handler.js` | 2 days |
| R7  | Medium | Per-agent / per-provider idle thresholds. Surface "last tool name" in idle warnings. | `src/core/runtime` settings, `src/coordinator/watcher/`, `src/api/sse.js`, UI | 1 day |
| R11 | Low | Add `task_runs.parent_relationship` (`stage_progression` / `recovery_continuation` / `manual_retry`). Backfill from diagnostics. | `src/core/db/schema/`, `src/core/db/queries/runs.js`, `src/coordinator/watcher/` | 0.5 day |
| R8  | Low | Decouple recovery-budget depth from depth-of-completed-work. (Folds into R2.) | `src/coordinator/watcher/run-handler.js` | merged with R2 |
| R9  | Low | Project-level `allowed_agents` allowlist. | `src/core/db/queries/projects.js`, `src/coordinator/watcher/delegation-handler.js`, UI | 1 day |
| R10 | Low-Med | Required `cancel_reason` (or picklist) on user cancellations. | `src/api/routes/tasks.js`, UI cancel modal | 0.5 day |

### Agent-config changes (data under `~/.worklab/agents/` or `data-template/agents/`)

| ID  | Sev | Title | Affected files | Rough effort |
|-----|-----|-------|----------------|--------------|
| A1  | High | Tighten the qa-reviewer's prompt to **always** wrap the final reply in a `worklab.v2` JSON block and forbid trailing markdown. Currently produces text reviews that happen to also include a JSON block, which the parser sometimes misses. (Mitigates F2 even before R3 lands.) | `~/.worklab/agents/benchmark-qa-reviewer/system_prompt.md` (or wherever the system prompt lives in the agents store) | 0.5 day |
| A2  | Medium | Configure the Playwright MCP server (or the qa-reviewer's MCP allowlist) to use `mcp__playwright__browser_snapshot` (which is text-based DOM) instead of `mcp__playwright__browser_take_screenshot` whenever feasible. Reserve screenshots for cases where pixel evidence is required. | `~/.worklab/agents/benchmark-qa-reviewer/mcp.json`, agent prompt | 0.5 day |
| A3  | Medium | Add per-agent run-budget warnings (cost / duration / turns soft caps with operator notification, hard caps that pause). The runtime-engineer 998-s ghost-success and the 13-min cancellations would be caught earlier. | New `src/core/agent-budgets.js` + `~/.worklab/agents/<agent>/budget.json` | 1–2 days |
| A4  | Low | Document the M0 `auto_plan_execute` policy as the project default; add a project-level setting so new projects don't re-derive it. | `data-template/projects/`, `src/core/db/queries/projects.js` | 0.5 day |

### Order of attack (recommended)

1. **R1 + A2** — knock out the screenshot bloat both at the harness level and at the agent-config level. ~2 days. Affects 28% of runs.
2. **R3 + A1** — make invalid_result recover, plus fix the cause at the prompt layer. ~1.5 days. Closes a silent-data-loss gap.
3. **R2** — salvage partial completion. ~2–3 days. Closes a misleading-error gap.
4. **R5** — coordinator shutdown handling. ~2–4 days. Saves 11+ minutes per restart cycle.
5. **R4 + R11 + R12** — diagnostic / observability fixes. ~2 days total. Makes the next audit much easier.
6. Everything else as time permits.

---

## 10. Open questions

These would need additional investigation outside the scope of this audit:

1. **What triggered the `WV2K36Fkk03LWo2c652kO` review** (M4 W6 recovery) 24 minutes after the first review failed? Was it user-initiated via the UI, an automation, or a scheduler quirk? `task_comments` is silent. (Checking `src/core/db/queries/automation-audit.js` and any automation history might explain this.)
2. **How did `Df4JbTXIfHHEldaGYiUlD` move from `error` to `done` with no successful review?** No comments after the failure, no further runs, but `stage = done` and `failure_count = 0`. Need to inspect the `task_state_transitions` table (if it exists) or the API/UI audit trail.
3. **Why are 4 out of 5 `provider_unavailable` failures fast-fails (<60 s)?** Is there a shared cause (provider warm-up, session establishment) or is this random variance? Correlating against any Codex-side incident reports for May 1–2 2026 would help.
4. **Did the M7D coordinator restart correspond to a known operator action?** The shell history / system logs around 09:48–10:13 on May 2 would confirm whether this was a `worklab restart` or a daemon-supervisor incident.
5. **Are the "QA in execute" qa-reviewer runs (n=18) substantively different work from the "review" qa-reviewer runs (n=60)?** Sampling suggests yes (the execute runs do Playwright walkthroughs at multiple viewports; the review runs do compact verification). If they are different, the cost analysis in §3.3 should split them. If they are not, F6 is more urgent.
6. **What model are the 4 "model = None" qa-reviewer runs actually using?** Only the 4 errored/cancelled qa-reviewer runs are missing `agent_logs.model`. Looks like the model field is only populated on successful exit. Worth confirming in `src/worker/result-emitter.js`.

---

## 11. Appendix

### A. Extraction queries

The dataset was extracted from `~/.worklab/worklab.db` using these queries (reproduced verbatim from `tmp/runtime-audit/extract.py`):

```sql
-- All tasks for the project
SELECT * FROM tasks WHERE project_id = 'CRoBAXtjQxo0' ORDER BY created_at;

-- All runs for the project
SELECT * FROM task_runs WHERE project_id = 'CRoBAXtjQxo0' ORDER BY started_at;

-- All agent_logs joined to those runs
SELECT * FROM agent_logs WHERE task_run_id IN (
  SELECT id FROM task_runs WHERE project_id = 'CRoBAXtjQxo0'
);

-- All comments for those tasks
SELECT * FROM task_comments WHERE task_id IN (
  SELECT id FROM tasks WHERE project_id = 'CRoBAXtjQxo0'
) ORDER BY created_at;
```

### B. Inventory of every non-success run

| run_id | task_id | task_title | mode/stage | agent | failure_kind | dur (s) | parent_run | notes |
|---|---|---|---|---|---|---:|---|---|
| `DT7e7zLnjeXRVjoD0oeCF` | `6FdEjoguViyBFQD7TaX7u` | M2 modular persistence | execute/execute | platform-engineer | `provider_unavailable` | 61 | — | clean recovery (R2) |
| `T7xjZctMOuNy1ze0POdHY` | `kBzJvxzf2z8BydZMlvHHx` | M2 PR import workspace | plan/plan | product-lead | `cancelled_user` | 136 | — | no reason recorded |
| `4zIZKWmMnQF5mzzr4i9xb` | `c4zfJDJNeu7B585hWlSeF` | M3 runtime impl | execute/execute | runtime-engineer | `cancelled_user` | 779 | — | "Commit repair requested before continuing shared project workdir" |
| `01i6FI78ATSpwGYTahdrR` | `Df4JbTXIfHHEldaGYiUlD` | M3 UI PR processing | review/review | qa-reviewer | `invalid_result` | 304 | `wy3R8M…` | orphaned; task moved to done by hand |
| `NDnzafBuAelMHHP64vihg` | `tYw4GF6f3oJEySgdUOHsw` | M4 dataset module | plan/plan | product-lead | `provider_unavailable` | 55 | — | clean recovery |
| `YxLgWnIaRWboZZVjyGFQY` | `W6yaz4xdyx30df9OUX8MV` | M4 QA verify harness | review/review | qa-reviewer | `invalid_result` | 59 | `cFIGsu…` | recovered 24 min later by `WV2K36…` (no recovery_* markers) |
| `W3tzSfytM969ZqmfDvz2Y` | `DqF2VoWfunNd15QXz3L0p` | M5 runtime adapter | execute/execute | runtime-engineer | `provider_unavailable` | 9 | — | fast-fail; recovered by `Ec6ZS…` |
| `Ec6ZSCipMSKGAdlhfV88S` | `DqF2VoWfunNd15QXz3L0p` | M5 runtime adapter | execute/execute | runtime-engineer | `provider_unavailable` | 998 | `W3tzS…` | **GHOST SUCCESS** — committed 17c89b7 + journal_summary, then terminated. Misclassified as failure. |
| `YYVSFAkwnNiJQkTVr4Zg7` | `TjZaj1DUVu01lGhr6zRRB` | M5 inspection comparison | execute/execute | ui-engineer | `provider_unavailable` | 439 | — | clean recovery |
| `H16I7AQGJzMJeK3AUsqVa` | `SKf1SsTTU3OUfv4MmNHH6` | M7A resource route | execute/execute | ui-engineer | `cancelled_user` | 778 | — | no reason recorded; 44 min before retry |
| `q8Rc38XnAzDwBGSagBgPY` | `0ygqqmVKThm7Mvk2b1z1h` | M7C QA drill-in | execute/execute | qa-reviewer | `cancelled_stale` | 489 | — | coordinator_shutdown |
| `QAcRd6IsAv0lKDTtRkSHj` | `7KhHThu5jryTAq91XzgIT` | M7D mobile QA | plan/plan | product-lead | `cancelled_stale` | 44 | — | coordinator_shutdown |
| `gUO3vCN2Uelvs5GXtMrPh` | `7KhHThu5jryTAq91XzgIT` | M7D mobile QA | execute/execute | qa-reviewer | `cancelled_stale` | 640 | — | coordinator_shutdown; 6.1 MB events |
| `QF2iCnxpC4OTbOT1HZaGc` | `7KhHThu5jryTAq91XzgIT` | M7D mobile QA | review/review | product-lead | `provider_unavailable` | 167 | `vDrPe…` | clean recovery |

### C. Glossary

- **`worklab.v2`** — the JSON envelope an agent must return (see `src/ai/result/contract.js`). Required: `decision`, `summary`. Optional: `details`, `final_text`, `artifacts`, `blocking_issues`, `pending_actions`, `questions`, `subtasks`.
- **`failure_kind`** — terminal classification of a non-successful run (see `src/ai/failure.js`). Values seen on this project: `provider_unavailable`, `invalid_result`, `cancelled_user`, `cancelled_stale`. Other defined values not seen here: `spawn`, `timeout`, `stall`, `usage_limit`, `tool_failure`, `provider_unavailable_exhausted`, `child_failed`, `budget_exceeded`, `cancelled`, `cancelled_signal`, `abandoned`.
- **`continuation`** — a new `task_runs` row spawned to retry a failed run, with `parent_run_id` pointing at the failure and `diagnostics.continuation_*` keys populated. Distinct from a "stage progression" run that also uses `parent_run_id` but has no `continuation_*` keys.
- **`context_risk`** — diagnostic field set by the worker, values `normal` / `high`. `high` is set when `event_chars` exceeds an internal threshold or a single tool result exceeds another threshold.
- **Recovery continuation chain** — when a run's `parent_run_id` chain through `task_runs` includes one or more failed runs.
- **Stage progression** — when a run's `parent_run_id` points at a *successful* run in a different stage (e.g. review.parent = execute).

### D. Files in `tmp/runtime-audit/`

- `extract.py` — extracts per-task JSON from `worklab.db`.
- `summarize.py` — generates one markdown summary per root task.
- `lifecycle.py` — generates the compact ASCII lifecycle dump.
- `analyze.py` — computes per-agent / per-stage / cost / context metrics.
- `index.json` — flat list of every run with key fields.
- `stats.json` — aggregate counts (statuses / failure_kinds / agents / decisions).
- `lifecycle.txt` — chronological per-task ASCII view.
- `analysis.txt` — output of `analyze.py`.
- `raw/<task_id>.json` — full per-task data with all runs and children inlined.
- `notes/<task_id>.md` — per-task structured notes (intermediate).

These working files are intentionally left in place under `tmp/` (gitignored) so the audit can be re-run / verified later.

---

*End of audit.*
