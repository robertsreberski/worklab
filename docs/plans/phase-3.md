> Reconstructed 2026-04-22 from commit history (phase-2..phase-3) and spec §8. The original plan file was overwritten post-execution; this document preserves the plan intent for posterity.

# Worklab — Phase 3 Implementation Plan

**Spec:** `docs/spec/worklab-design.md` §8 "Phase 3 — Review flow, KB" (authoritative).

**Repo root:** `/opt/claude-workspace/local/worklab`. On branch `main` at tag `phase-2`.

**Phase 3 tag:** `phase-3` (HEAD: `cfc005d`)

**Goal:** Tasks with a reviewer agent auto-review; approvals flow to `done`, rejections flow back to `in_progress` with notes. Humans and agents can manage a shared knowledge base. Pinned KB entries are included in agent system prompts.

---

## Context

Phase 2 shipped the execute-mode worker: Claude agent runs, streams events live, journals its work, task parks at `in_review` (with no further automation). Phase 3 completes the loop:

1. **Reviewer worker** — when a task reaches `in_review` and has a `reviewer_agent` set, the coordinator automatically spawns a second worker in `--mode review`. The reviewer reads the executor's output, produces a verdict (`APPROVE` or `REJECT`), and the coordinator routes accordingly.
2. **Knowledge base** — `src/core/kb.js` provides frontmatter-aware CRUD for `data/knowledge/<slug>.md` files. MCP tools expose `kb_create/update/delete/read/list` to agents. A REST API and web UI let humans manage the KB. Pinned entries are surfaced in agent system prompts.

Phase 2 left `task-watcher.js` stubbed at the review boundary; Phase 3 makes it real.

---

## Out of scope

- Semantic search / embeddings (`kb_search` is stubbed; deferred to Phase 5)
- Multi-SDK (OpenAI, Vercel) + custom providers (Phase 4)
- Consolidation cron + memory consolidation (Phase 5)
- Service install, backup (Phase 5)

---

## Model and review policy

- **Opus 4.7 + full two-stage review**: T3 (review prompt), T6 (reviewer wiring + state machine alignment), T7 (review-mode worker), T13 (e2e lifecycle tests). These are the "a bug here silently corrupts the review loop" tasks.
- **Sonnet + spec-only review**: All other tasks (KB CRUD, REST routes, simple UI components, seeding, verdict parser).

---

## File structure

### New files

```
src/
  core/
    kb.js                              — frontmatter-aware KB CRUD (kbList/kbRead/kbCreate/kbUpdate/kbDelete/kbPinned)
    review.js                          — parseVerdict helper
    review-exec.js                     — extractExecutionFromEvents() pure helper
  api/
    routes-kb.js                       — REST routes: GET/POST /api/kb, GET/PATCH/DELETE /api/kb/:slug
  ui/src/
    routes/
      Knowledge.jsx                    — KB list with search/filter + SSE refresh
      KbEdit.jsx                       — create/edit/delete with slug validation
    components/
      CommentAuthor.jsx                — author chip with type-specific styling
data-template/
  knowledge/
    welcome.md                         — updated with frontmatter (T12)
src/__tests__/
  core/
    kb.test.js                         — 41 + 11 + 1 + more = comprehensive KB unit tests
    review.test.js                     — parseVerdict edge cases
    review-exec.test.js                — extractExecutionFromEvents unit tests
  api/
    routes-kb.test.js                  — REST API integration tests
  mcp/
    worklab-tools-kb.test.js           — MCP KB tool tests
  coordinator/
    task-watcher-review.test.js        — reviewer spawn/verdict/error tests
  e2e/
    review-lifecycle.test.js           — APPROVE/REJECT full lifecycle
    kb-lifecycle.test.js               — KB CRUD round-trip
```

### Modified files

```
src/core/
  context.js                           — add buildReviewSystemPrompt; defensive defaults
src/coordinator/
  task-watcher.js                      — wire reviewer spawn + verdict handling + error alignment
src/core/
  state-machine.js                     — add set_error_text side effect to run_failed
src/mcp/
  worklab-tools.js                     — add kb_create/update/delete/read/list MCP tools
src/api/
  server.js                            — mount routes-kb
  src/ui/src/lib/api.js                — add KB client methods
  src/ui/src/App.jsx                   — add Knowledge + KbEdit routes, topnav entry
src/worker.js                          — split into execute/review mode; add pinned KB injection
src/ui/src/components/
  CommentList.jsx                      — consume CommentAuthor chip
  TaskCard.jsx                         — add error dot indicator
src/ui/src/styles.css                  — author chip + verdict badge + error dot styles
```

---

## Tasks

### T1 — KB core: frontmatter-aware CRUD (`src/core/kb.js`)

**Commits:** `ab0fd65` (main), `d5e5e94` (follow-up: fsync durability + string coercion), `bb07485` (follow-up 2: comma quoting)

**Files:** `src/core/kb.js`, `src/__tests__/core/kb.test.js`

Introduces `kbPath(dataDir, slug)`, `kbList(dataDir)`, `kbRead(dataDir, slug)`, `kbCreate(dataDir, slug, fields)`, `kbUpdate(dataDir, slug, patch)`, `kbDelete(dataDir, slug)`. Parses both flow (`tags: [a, b]`) and block (`- item`) YAML array syntax. Validates slugs as `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Writes atomically via `writeAtomic()` (tmp + fsync + rename + parent fsync for power-loss durability). Lists without loading bodies for performance. String values that re-parse as non-strings (booleans, numbers, null, flow arrays, etc.) are double-quoted with escape encoding to survive round-trips. `readFrontmatterOnly` uses a strict terminator pattern so a mid-body `---line` does not prematurely close the frontmatter block. Malformed files in `kbList` log a warning to stderr and are skipped; the list still succeeds.

**Acceptance criteria:**
- `kbCreate` + `kbRead` + `kbUpdate` + `kbDelete` round-trip correctly.
- Slug validation rejects slugs with uppercase, spaces, or double-hyphens.
- `title: "true"` round-trips as string `"true"` (not boolean).
- `writeAtomic` leaves no `.tmp` files on success.
- `kbList` tolerates a malformed file (warns, continues).
- 52+ tests pass.

---

### T2 — KB REST API + UI client

**Commits:** `ff7f0d2` (main), `fe261f9` (follow-up: strip unknown PATCH fields)

**Files:** `src/api/routes-kb.js`, `src/__tests__/api/routes-kb.test.js`, `src/api/server.js`, `src/ui/src/lib/api.js`

Adds `GET /api/kb` (list, supports `?tag=&category=&pinned=`), `POST /api/kb` (create), `GET /api/kb/:slug` (read), `PATCH /api/kb/:slug` (update), `DELETE /api/kb/:slug` (delete). Unknown PATCH fields are stripped server-side so the `author` field cannot be spoofed. Mounts routes on the existing Express app via `server.js`. Adds KB client methods (`listKb`, `createKb`, `getKb`, `updateKb`, `deleteKb`) to `api.js`.

**Acceptance criteria:**
- All five REST operations return correct status codes.
- `PATCH` with `{ author: "evil" }` is silently ignored.
- 267+ route tests pass.

---

### T3 — Review system prompt builder

**Commits:** `5c2a4cc` (main), `6046839` (follow-up: defensive defaults)

**Files:** `src/core/context.js`, `src/__tests__/core/context.test.js`

Adds `buildReviewSystemPrompt(agent, task, execution, opts)` to `context.js`. The review prompt shares the first six sections with `buildExecuteSystemPrompt` (agent instructions, pinned KB, skill index, memory, journal tail, task block) then replaces the cadence instruction with: *"Review the executor's work against the task instructions. Respond with a final message whose first line is either `VERDICT: APPROVE` or `VERDICT: REJECT`. If REJECT, follow with bullet-pointed notes the executor can act on."* An `## Executor Output` section inlines the prior run's agent name, turn count, duration, and final text. `formatExecutorOutput` defaults `agentName` to `'unknown'`, `numTurns` to `0`, `durationMs` to `0` to prevent literal `undefined` strings in the rendered prompt. `formatDuration` hardened against negative/NaN values via `Math.max(0, Math.trunc(...))`.

**Acceptance criteria:**
- `buildReviewSystemPrompt` includes a `VERDICT` instruction.
- Executor output section renders cleanly when execution fields are undefined.
- 23+ context tests pass.

---

### T4 — KB MCP tools (`kb_create/update/delete/read/list`)

**Commits:** `092c59f`

**Files:** `src/mcp/worklab-tools.js`, `src/__tests__/mcp/worklab-tools-kb.test.js`

Extends the built-in MCP server with five KB tools validated by Zod:

| Tool | Purpose |
|---|---|
| `kb_create(slug, title, body, tags?, category?, pinned?)` | Create `knowledge/<slug>.md`. Fails if slug exists. |
| `kb_update(slug, patch)` | Patch frontmatter and/or body. |
| `kb_delete(slug)` | Delete entry. |
| `kb_read(slug)` | Return full body + frontmatter. |
| `kb_list({tag?, category?, pinned?})` | List entries with optional filters. |

Each tool reads `WORKLAB_DATA_DIR` from the environment and delegates to `src/core/kb.js`. `kb_search` is intentionally excluded (Phase 5).

**Acceptance criteria:**
- 234+ MCP KB tool tests pass.
- Agent can `kb_create` during a run; the entry appears at `data/knowledge/<slug>.md`.

---

### T5 — Verdict parser (`src/core/review.js`)

**Commits:** `ab903c6`

**Files:** `src/core/review.js`, `src/__tests__/core/review.test.js`

Adds `parseVerdict(text)` — pure function. Scans the first non-empty line of the reviewer's final text for `/^VERDICT:\s*(APPROVE|REJECT)\b/i`. Returns `{ verdict: 'APPROVE'|'REJECT', notes: string }` or `null` if the pattern is absent. `notes` is the remainder of the text after the verdict line. 130+ tests cover edge cases: leading whitespace, mixed-case, trailing punctuation, embedded VERDICT lines, empty input.

**Acceptance criteria:**
- `parseVerdict("VERDICT: APPROVE\nLooks good")` → `{ verdict: 'APPROVE', notes: 'Looks good' }`.
- `parseVerdict("VERDICT: REJECT\n- Fix linting")` → `{ verdict: 'REJECT', notes: '- Fix linting' }`.
- `parseVerdict("No verdict here")` → `null`.
- 130+ tests pass.

---

### T6 — Coordinator: reviewer spawn + verdict routing + run_failed alignment

**Commits:** `3f7893b` (main), `ac6029e` (follow-up: atomicity + hardening)

**Files:** `src/coordinator/task-watcher.js`, `src/core/state-machine.js`, `src/__tests__/coordinator/task-watcher.test.js`, `src/__tests__/coordinator/task-watcher-review.test.js`

The most complex task in Phase 3. Brings the full review loop to life:

**State machine** (`state-machine.js`): `run_failed` now emits a third side effect `set_error_text` alongside `post_error_comment` and `mark_badge_red`, so the watcher can apply error text through the reducer rather than bypassing it.

**Task watcher** (`task-watcher.js`):
- `applySideEffects` handles `set_error_text`, `post_error_comment`, `post_review_comment` in one central dispatch; DB mutations wrapped in `db.transaction()` for atomicity; broadcast stays outside the transaction.
- Executor complete → `run_completed` reducer. When reducer emits `spawn_reviewer`, a second worker is spawned in `--mode review` with `WORKLAB_PRIOR_RUN_ID` set to the executor's run ID, enabling the reviewer to locate prior output.
- `onWorkerExit` reads `mode` from `task_runs` so execute and review paths share one dispatch.
- Review APPROVE → `review_approved` + system comment "VERDICT: APPROVE". Review REJECT → `review_rejected` (reducer clears `error_text`) + rejection notes as a system comment. Null verdict → `in_review` with a warning comment and `error_text` set.
- Review cancelled/errored → system comment but status unchanged (no inappropriate `todo` flip).
- Executor failures: removed the direct-to-`todo` bypass; reducer-driven path posts ERROR comment, sets `error_text`, keeps task `in_progress`.
- All `nextStatus` call sites check for reducer error side effects and log + insert "State drift" system comment on illegal transitions.

**Tests**: `task-watcher-review.test.js` (10 scenarios: executor failure alignment, no-reviewer parking, APPROVE flow, REJECT flow, missing-VERDICT null case, reviewer-cancelled, reviewer-error, `WORKLAB_PRIOR_RUN_ID` plumbing, DB transaction atomicity).

**Acceptance criteria:**
- Executor exit → reviewer spawned automatically if `reviewer_agent` set.
- APPROVE → task `done`, `completed_at` set, 2 task_runs rows.
- REJECT → task `in_progress`, rejection comment posted, `error_text` cleared.
- Executor failure → task stays `in_progress` with `error_text` populated.
- 318+ tests pass.

---

### T7 — Worker review mode + verdict emission

**Commits:** `a14e54d`

**Files:** `src/worker.js`, `src/core/review-exec.js`, `src/__tests__/core/review-exec.test.js`

Refactors `worker.js` to split execute/review modes:

- Both modes share `loadCommonSetup()` (agent, task, skills, MCP config, journal path, memory path).
- Review mode requires `WORKLAB_PRIOR_RUN_ID`. Loads prior run's events from `agent_logs`, extracts execution summary via `extractExecutionFromEvents()` (in new `review-exec.js`), builds a review system prompt, runs the agent, and unconditionally emits a `{ type: "verdict", verdict: "APPROVE"|"REJECT"|null, notes: "..." }` event.
- Exits with code `2` on null verdict, `0` on APPROVE or REJECT.
- New pure helper `review-exec.js` implements `extractExecutionFromEvents(events)` → `{ finalText, agentName, numTurns, durationMs }`.

**Acceptance criteria:**
- Worker in `--mode review` emits a `verdict` event on stdout.
- Exit code `2` on null verdict.
- 11+ review-exec unit tests pass.
- Worker integration test exercises both execute and review modes sequentially.

---

### T8 — (Not explicitly tagged in commits — included in T6/T7 wiring)

The task numbering in the commit log jumps from T7 to T9. T8 was likely the wiring between T6 and T7 (connecting `task-watcher`'s reviewer spawn to `worker.js`'s review mode), completed as part of the T6/T7 commits above.

---

### T9 — UI: Knowledge list and KB editor

**Commits:** `13ae6bd`

**Files:** `src/ui/src/routes/Knowledge.jsx`, `src/ui/src/routes/KbEdit.jsx`, `src/ui/src/App.jsx`

Adds two new UI routes:

- `Knowledge.jsx`: list view with text search, optional tag/category filter chips, real-time refresh on `kb_*` SSE events (via global event stream). Pinned entries surfaced at top.
- `KbEdit.jsx`: create/edit/delete form with slug input (validated `^[a-z0-9]+(?:-[a-z0-9]+)*$`), title, tags (comma-separated), category, pinned toggle, and a textarea body. Delete requires confirmation.
- Both wired into `App.jsx` hash routing (`#/knowledge`, `#/knowledge/new`, `#/knowledge/:slug`) and topnav.

**Acceptance criteria:**
- Navigate to `#/knowledge` → list renders.
- Create new entry via `#/knowledge/new`, save → appears in list.
- Edit existing entry → changes persist.
- Delete entry → removed from list.

---

### T10 — Pinned KB entries in agent system prompts

**Commits:** `0e55cc7`

**Files:** `src/core/kb.js`, `src/worker.js`, `src/__tests__/core/kb.test.js`

Adds `kbPinned(dataDir, limit)` to `kb.js` — returns up to `limit` (default 10, matches `settings.kb_pinned_limit`) KB entries where `pinned: true`. Injects the returned entries into the system prompt in `worker.js` (for both execute and review modes), formatted as a fenced `## Pinned Knowledge` section. 151+ additional tests including pinned listing, limit enforcement, and system-prompt injection.

**Acceptance criteria:**
- Agent run with a pinned KB entry has that entry in the system prompt (verifiable via context.test.js assertions on the rendered prompt text).
- `kbPinned` returns only entries with `pinned: true`, capped at the limit.
- No regression in existing tests.

---

### T11 — UI: comment author chips + verdict badges + kanban error dot

**Commits:** `dc0bbfe`

**Files:** `src/ui/src/components/CommentAuthor.jsx`, `src/ui/src/components/CommentList.jsx`, `src/ui/src/components/TaskCard.jsx`, `src/ui/src/styles.css`

Visual polish for the review flow:

- `CommentAuthor.jsx`: new component rendering an author chip styled by `author_type` (`human` = blue, `agent` = green, `system` = grey). System comments with `VERDICT: APPROVE` or `VERDICT: REJECT` get a distinct verdict badge (green/red).
- `CommentList.jsx`: updated to use `CommentAuthor`; reviewer verdict comments visually distinct.
- `TaskCard.jsx`: adds a red dot indicator on cards with `error_text` set (executor failure visible on the kanban board without opening the task).
- `styles.css`: new classes for `.comment-author-chip`, `.verdict-badge-approve`, `.verdict-badge-reject`, `.task-error-dot`.

**Acceptance criteria:**
- Human, agent, and system comments render with distinct chips.
- APPROVE verdict badge is green; REJECT is red.
- A task with `error_text` shows a red dot on its kanban card.

---

### T12 — Seed welcome KB entry for first boot

**Commits:** `f436b77`

**Files:** `data-template/knowledge/welcome.md`

Updates the placeholder `welcome.md` in `data-template/knowledge/` to include proper YAML frontmatter (`title`, `slug`, `tags`, `category`, `pinned: true`, `author: human`, `created_at`, `updated_at`) matching the KB file format from §4.2. The welcome entry is pinned so it appears in agent system prompts on first boot, demonstrating the feature.

**Acceptance criteria:**
- `kbRead(dataDir, 'welcome')` returns a valid entry after first boot seeding.
- Entry is pinned and appears in `kbPinned()` results.

---

### T13 — E2E: reviewer APPROVE/REJECT lifecycle test

**Commits:** `3599b8d`

**Files:** `src/__tests__/e2e/review-lifecycle.test.js`

244-line e2e test covering the full reviewer loop using mode-specific fake workers:

**Scenario A (APPROVE):**
- Task is created with both `executor_agent` and `reviewer_agent`.
- `POST /api/tasks/:id/run` triggers executor fake-worker.
- Task auto-flips to `in_review`, reviewer fake-worker is spawned automatically.
- Final state: `task.status === 'done'`, `completed_at` set, 2 `task_runs` rows (both `complete`), system comment "VERDICT: APPROVE".

**Scenario B (REJECT):**
- Same setup, reviewer fake-worker emits `VERDICT: REJECT` with notes.
- Final state: `task.status === 'in_progress'`, `error_text` cleared, system rejection comment with notes, 2 `task_runs` rows.

Mode-specific fake-worker scripts are injected via a spawn wrapper reading `--mode` from worker args. No changes to `fake-worker.js`.

Note: Scenario C (pinned KB in system prompt) was intentionally excluded — the fake worker does not receive real prompts; direct builder coverage lives in `context.test.js` (T3) and KB e2e is covered in T14.

**Acceptance criteria:**
- Both APPROVE and REJECT scenarios pass deterministically.
- `task_runs` table has exactly 2 rows per scenario.
- System comments contain expected verdict text.

---

### T14 — E2E: KB round-trip lifecycle test

**Commits:** `cfc005d`

**Files:** `src/__tests__/e2e/kb-lifecycle.test.js`

226-line e2e test against a live coordinator + real filesystem. Covers:
- Create → read → update → delete round-trip via REST.
- List filtering by tag and category.
- Pinned entries appear first in list.
- Invalid slug rejected with 400.
- Duplicate slug rejected with 409.

**Acceptance criteria:**
- All KB REST operations succeed against a running coordinator.
- Slug validation errors return 400.
- Duplicate create returns 409.
- 226-line test file, all assertions pass.

---

### T15 — (Implicit: final tag + test count verification)

Final verification before tagging `phase-3`:

```bash
cd /opt/claude-workspace/local/worklab
npm test
# Expected: 401 tests passing, 0 failing
git tag phase-3
```

---

## Verification

After all tasks complete:

```bash
# Full test suite
npm test
# → 401 tests, 0 failing

# Manual smoke:
# 1. Start coordinator: npm start
# 2. Create an agent with reviewer_agent set
# 3. Create a task, assign executor + reviewer
# 4. Click Run now → watch execute worker stream events
# 5. Task auto-flips to in_review → reviewer spawns automatically
# 6. Reviewer emits APPROVE → task lands at done (green)
# 7. OR reviewer emits REJECT → task returns to in_progress with notes
# 8. Navigate to #/knowledge → create a KB entry, pin it
# 9. Run another task → verify pinned entry appears in system prompt (check activity log)
```

---

## What Phase 4 will add

Phase 4 adds the multi-SDK layer and custom provider registry:

- `src/core/crypto.js` — AES-256-GCM encrypted API keys, HKDF master key.
- `src/core/providers.js` — URL allowlist, model discovery (`/v1/models`, `/api/tags`).
- `src/core/ai-openai.js` + `src/core/ai-vercel.js` — OpenAI Agents SDK and Vercel AI SDK dispatch paths (Vercel covers Ollama + OpenAI-compat).
- `src/api/routes-providers.js` + `Providers.jsx` — provider CRUD, model discovery UI.
- `AgentEdit.jsx` extended with a full model picker showing real model names.
- `resolveModel` extended to parse `vercel:<providerId>:<modelName>` and `openai:<model>` forms.
