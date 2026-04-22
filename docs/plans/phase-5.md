> Reconstructed 2026-04-22 from commit history (phase-4..phase-5) and spec §8. The phase was executed without a committed plan file; this document preserves the plan intent.

# Worklab — Phase 5 Implementation Plan

**Spec:** `docs/spec/worklab-design.md` §8 "Phase 5 — Consolidation, semantic search, service install, backup, activity & settings polish" (authoritative).

**Phase plans:** `docs/plans/phase-4.md` (predecessor) · this file · `docs/plans/phase-6-roadmap.md` (successor).

**Repo root:** `/opt/claude-workspace/local/worklab`. On branch `main` at tag `phase-4`.

**Phase 5 tag:** `phase-5`

**Goal:** Tool is daily-driver complete. Nightly memory consolidation runs automatically, KB and journals are semantically searchable, the tool can install itself as a background service, and you can back up your data.

---

## Context

Phase 4 shipped the multi-SDK dispatch layer and custom provider registry: agents can now execute against Ollama, OpenAI, Groq, or any OpenAI-compatible endpoint, with API keys encrypted at rest and a full Providers management page in the UI.

Phase 5 finishes the v1 product across four dimensions:

1. **Memory consolidation** — agents accumulate unbounded journals over time. The consolidation worker reads the full journal, asks the AI to rewrite `MEMORY.md` into a structured Procedures/Facts/Gotchas format (deduped, stale entries aged out), and records the run in `agent_consolidations`. A nightly cron fires automatically; a "Consolidate now" button enables on-demand runs.

2. **Hybrid semantic search** — KB entries, journal files, and MEMORY.md are indexed into an SQLite embeddings table (via `nomic-embed-text` on Ollama, configurable). A chokidar filesystem watcher re-indexes on every file change. Search returns FTS5 + cosine-similarity blended results. Three new MCP tools expose search to agents at runtime.

3. **Service install / backup** — `worklab install-service` and `worklab uninstall-service` generate and load a macOS LaunchAgent plist or a Linux systemd user unit, so the coordinator survives reboots without a tmux/screen workaround. `worklab backup` snapshots the `data/` directory to a timestamped `.tar.gz`.

4. **Activity & Settings polish** — paginated Activity feed (cursor-based), SSE live-tail, Settings page additions for embedding model, consolidation schedule, encryption key status, and other runtime knobs.

---

## Out of scope

Deferred to v2 or later (see spec §2 non-goals):

- Scheduled / recurring / cron tasks
- Cost budgets or enforcement
- Desktop app shell (Electron/Tauri)
- Workflow chains (task A auto-creates task B)
- Cloud backup / sync
- Skill lab (AI-authored skills with human approval gate)
- Team / multi-user features
- Windows support

---

## Model and review policy

- **Opus 4.7**: T2 consolidation system prompt design (correctness of the MEMORY.md rewrite directive), T1 schema migration (idempotency guarantees).
- **Sonnet**: All other tasks — embeddings backend, search indexer, REST routes, CLI install/backup, UI pages. Mechanical wiring, spec-driven.

---

## File structure

### New files

```
src/
  core/
    embeddings.js                      — vector storage + retrieval, FTS5 hybrid search, testEmbeddingBackend()
    settings.js                        — typed settings registry with validation
  coordinator/
    consolidation-cron.js              — createConsolidationManager(): nightly schedule, runNow(), shutdown()
    search-indexer.js                  — chokidar FS watcher: ingest KB/journal/memory into embeddings index
  api/
    routes-search.js                   — GET /api/search?q= — hybrid semantic + FTS results with excerpts
    routes-activity.js                 — (extended) cursor-based pagination
    routes-settings.js                 — (extended) embedding model, consolidation hour, PATCH validation
  cli/
    install-service.js                 — worklab install-service (macOS launchd + Linux systemd)
    uninstall-service.js               — worklab uninstall-service
    backup.js                          — worklab backup (tar.gz snapshot of data/)
  ui/src/
    routes/
      Activity.jsx                     — paginated run history: status chips, model/effort badges, SSE live-tail
src/__tests__/
  core/
    embeddings.test.js                 — embedding storage, retrieval, FTS hybrid, testEmbeddingBackend
  coordinator/
    consolidation-cron.test.js         — scheduling, runNow, skip-on-no-new-entries, agent_consolidations rows
  api/
    routes-search.test.js              — search REST integration tests
    routes-activity.test.js            — pagination cursor tests
    routes-settings.test.js            — (extended) PATCH validation for new settings fields
  cli/
    backup-service.test.js             — backup archive creation + round-trip restore
  mcp/
    worklab-tools-kb.test.js           — (extended) kb_search, journal_search, memory_search tool tests
```

### Modified files

```
src/core/
  schema.js                            — v3 migrations: nullable task_runs.task_id, embeddings + FTS5, agent_consolidations
  db.js                                — expose runMigrations() helper
  context.js                           — add buildConsolidationSystemPrompt() + CONSOLIDATION_DIRECTIVE
  journal.js                           — add readFullJournal() + writeMemory() (atomic tmp-rename)
src/
  worker.js                            — add "consolidate" mode: readFullJournal → AI rewrite → writeMemory
  coordinator.js                       — wire consolidation manager + search indexer into startup/shutdown
src/api/
  routes-agents.js                     — POST /api/agents/:name/consolidate → 202 with runId
src/mcp/
  worklab-tools.js                     — add kb_search, journal_search, memory_search tools
src/cli/
  index.js                             — register backup, install-service, uninstall-service subcommands
  doctor.js                            — add embedding backend check + getKeyFingerprint() verification
src/ui/src/
  routes/
    Settings.jsx                       — embedding model picker, consolidation hour, encryption key status
    Knowledge.jsx                      — semantic search via GET /api/search
  coordinator/
    spawn-worker.js                    — consolidation run support
src/__tests__/
  helpers/
    test-server.js                     — pass consolidation proxy to createServer()
  api/routes-tasks.test.js             — update for nullable task_id + schema v3
  coordinator/task-watcher.test.js     — update for schema v3 helpers
  coordinator/spawn-worker.test.js     — update for consolidation mode
  e2e/run-lifecycle.test.js            — update for schema v3 helpers + consolidation proxy
  e2e/review-lifecycle.test.js         — update for schema v3 helpers + consolidation proxy
  core/context.test.js                 — assertions for buildConsolidationSystemPrompt
README.md                              — add service install + backup commands
```

---

## Tasks

### T1 — Schema v3: nullable task_runs.task_id, embeddings/FTS, agent_consolidations

**Commit:** `2dc839f`

**Files:** `src/core/schema.js`, `src/core/db.js`, `src/__tests__/core/db.test.js`

Three migrations applied in `schema.js` under version 3:

1. **`task_runs.task_id` nullable** — consolidation runs are not tied to a specific task (they operate at the agent level). Making this column nullable allows `INSERT INTO task_runs (..., task_id, ...) VALUES (..., NULL, ...)` for consolidation run rows. Migration uses `ALTER TABLE … RENAME`→`CREATE TABLE`→`INSERT`→`DROP` pattern (SQLite's limited `ALTER TABLE` workaround).

2. **`embeddings` table** — stores embedding vectors: `id`, `source_type` (`kb`|`journal`|`memory`), `source_path`, `chunk_index`, `chunk_text`, `embedding_json`, `created_at`, `updated_at`. A covering index on `(source_type, source_path)` enables fast re-indexing on file change.

3. **`embeddings_fts` (FTS5 virtual table)** — full-text search over `chunk_text` with content/content-rowid linking back to `embeddings`. Enables hybrid FTS5 + vector search without a second SQLite file.

4. **`agent_consolidations` table** — tracks nightly (and on-demand) consolidation runs: `id`, `agent_name`, `run_id` (FK → `task_runs`), `entries_processed`, `status` (`complete`|`failed`|`skipped`), `created_at`.

`db.js`: `runMigrations()` function exposed at module level. Idempotent — safe to call on existing databases (migrations are guarded by schema version checks). Used by `worklab doctor` and `consolidation-cron.js` to ensure the schema is current before operating.

**Acceptance criteria:**
- `runMigrations()` on a fresh DB creates all v3 tables and sets schema version to 3.
- `runMigrations()` on a v2 DB applies only the delta; existing rows are preserved.
- `task_runs.task_id` accepts NULL without constraint violation.
- `embeddings_fts` can be queried with `MATCH` syntax.
- 23+ new `db.test.js` assertions pass.

---

### T2 — Consolidation: worker mode + cron + API endpoint

**Commit:** `20aadf6`

**Files:** `src/worker.js`, `src/core/context.js`, `src/core/journal.js`, `src/coordinator/consolidation-cron.js`, `src/api/routes-agents.js`, `src/coordinator.js`, `src/__tests__/coordinator/consolidation-cron.test.js`, `src/__tests__/api/routes-agents.test.js`

**`journal.js` helpers:**
- `readFullJournal(agentDataDir)` — reads all lines of `JOURNAL.md`, returns the full text.
- `writeMemory(agentDataDir, content)` — atomically writes `MEMORY.md` via tmp-file + rename (same durability guarantee as `writeAtomic`).

**`context.js` — `buildConsolidationSystemPrompt(agent, opts)`:**

```
CONSOLIDATION_DIRECTIVE:
  You are performing a memory consolidation for agent <name>.
  Read the journal below and rewrite MEMORY.md into three sections:
  ## Procedures — step-by-step approaches that have proven effective
  ## Facts — stable facts, preferences, and constraints
  ## Gotchas — pitfalls, past mistakes, and things to avoid
  Deduplicate aggressively. Remove entries more than 30 days old
  that have not been confirmed recently. Keep total length under 1000 words.
```

**Worker `--mode consolidate`:**
- Reads full journal via `readFullJournal()`.
- Calls `generateResponse()` with the consolidation system prompt. Max turns: 1 (single rewrite, no tool calls needed).
- Writes result via `writeMemory()`.
- Emits standard `task_run` events so the Activity feed surfaces the run.

**`consolidation-cron.js` — `createConsolidationManager(db, agentDataDir, generateResponse)`:**
- Schedules nightly runs at `settings.consolidation_hour` (default 3 AM).
- On each tick: enumerates agents, skips any with no new journal entries since the last consolidation run.
- For each eligible agent: inserts a `task_runs` row with `mode=consolidate, task_id=NULL`, spawns a consolidation worker, records outcome in `agent_consolidations`.
- Exposes `runNow(agentName)` — fires an immediate consolidation for a single agent, returns `runId`.
- Exposes `isActive(agentName)` — returns true if a consolidation is currently running for that agent.
- Exposes `shutdown()` — cancels any in-flight consolidation workers.

**`routes-agents.js`** — `POST /api/agents/:name/consolidate`:
- Returns `202 { runId }` immediately; consolidation runs asynchronously.
- Returns `409` if a consolidation is already active for the agent.

**`coordinator.js`** — wires consolidation manager and search indexer into startup/shutdown lifecycle.

**Acceptance criteria:**
- Consolidation worker for an agent with 10 journal entries produces a new `MEMORY.md`.
- `POST /api/agents/:name/consolidate` returns 202 with a `runId`; `task_runs` row inserted with `mode=consolidate, task_id=NULL`.
- Agent with no new entries since last consolidation is skipped (logged but not run).
- 100+ consolidation-cron tests pass.

---

### T3 — Semantic search: embeddings + FS indexer + MCP search tools + REST routes

**Commit:** `503e79c`

**Files:** `src/core/embeddings.js`, `src/coordinator/search-indexer.js`, `src/api/routes-search.js`, `src/mcp/worklab-tools.js`, `src/__tests__/core/embeddings.test.js`, `src/__tests__/api/routes-search.test.js`, `src/__tests__/mcp/worklab-tools-kb.test.js`

**`embeddings.js`:**
- Default backend: Ollama `nomic-embed-text` at `http://localhost:11434`. Configurable via `settings.default_embedding_model`.
- `embed(text)` → float array (768 dims for nomic-embed-text).
- `indexChunk(sourceType, sourcePath, chunkIndex, chunkText)` — embed + upsert into `embeddings` + update `embeddings_fts`.
- `hybridSearch(query, { limit, sourceType? })` — FTS5 match score + cosine similarity blended with a simple 0.5/0.5 weight. Returns ranked results with `sourcePath`, `chunkText`, and `score`.
- `testEmbeddingBackend()` — makes a test embed call, returns `{ ok, model, dims, latencyMs }`. Used by `worklab doctor`.

**`search-indexer.js`:**
- Uses `chokidar` to watch:
  - `data/knowledge/**/*.md` → KB entries
  - `data/agents/*/JOURNAL.md` → journals
  - `data/agents/*/MEMORY.md` → memory files
- On `add` / `change`: reads file, splits into ~512-token chunks, calls `indexChunk()` for each. Debounced at 500ms to coalesce rapid saves.
- On `unlink`: deletes all `embeddings` rows for that `source_path`.
- Exposes `shutdown()` for clean teardown (stops the watcher).

**`routes-search.js`:**
- `GET /api/search?q=<query>&type=<kb|journal|memory>&limit=<n>` — delegates to `hybridSearch()`.
- Returns `[{ sourcePath, excerpt, score, sourceType }]`.

**`worklab-tools.js` — three new MCP tools:**
- `kb_search(query, limit?)` — searches KB entries.
- `journal_search(query, agent?, limit?)` — searches journal chunks (optionally filtered to one agent).
- `memory_search(query, agent?, limit?)` — searches MEMORY.md chunks.

**Acceptance criteria:**
- Index a KB entry, call `kb_search` with a matching query → entry appears in results.
- FTS5 exact-phrase match ranks above cosine-only results.
- `testEmbeddingBackend()` returns `{ ok: true }` when Ollama is reachable.
- Search with no embedding backend returns graceful error (not a crash).
- 146 embeddings tests + 66 routes-search tests + 36 updated worklab-tools-kb tests pass.

---

### T4 — CLI install/uninstall/backup + Activity + Settings polish + Knowledge semantic search

**Commit:** `f87b620`

**Files:** `src/cli/install-service.js`, `src/cli/uninstall-service.js`, `src/cli/backup.js`, `src/cli/index.js`, `src/cli/doctor.js`, `src/core/settings.js`, `src/api/routes-settings.js`, `src/api/routes-activity.js`, `src/ui/src/routes/Activity.jsx`, `src/ui/src/routes/Settings.jsx`, `src/ui/src/routes/Knowledge.jsx`, `src/__tests__/cli/backup-service.test.js`, `src/__tests__/api/routes-settings.test.js`, `src/__tests__/api/routes-activity.test.js`, `src/__tests__/core/context.test.js`, and cross-cutting test updates`

**CLI — `worklab install-service`** (`install-service.js`):
- macOS: generates a `com.worklab.coordinator.plist` LaunchAgent targeting the current Node binary and working directory, copies to `~/Library/LaunchAgents/`, runs `launchctl load`.
- Linux: generates a `worklab.service` systemd user unit, copies to `~/.config/systemd/user/`, runs `systemctl --user enable --now worklab`.
- Validates that `worklab` is in PATH and that the data directory exists before writing service files.

**CLI — `worklab uninstall-service`** (`uninstall-service.js`):
- Unloads and removes the service file on both platforms.

**CLI — `worklab backup`** (`backup.js`):
- Creates a timestamped `.tar.gz` at `~/worklab-backups/worklab-<ISO8601>.tar.gz`.
- Excludes SQLite WAL/SHM files (snapshot only; DB is flushed via a checkpoint before archiving).
- Prints restore instructions on completion.

**CLI — `worklab doctor`** extended:
- New check: embedding backend reachable → calls `testEmbeddingBackend()`, reports model + latency.
- New check: encryption key present → calls `getKeyFingerprint()`, reports fingerprint.

**`settings.js`** — typed settings registry:
- Defines all valid setting keys with types, defaults, and validation rules.
- New settings: `default_embedding_model`, `consolidation_hour`, `journal_tail_lines`, `kb_pinned_limit`, `worker_timeout_ms`, `cancel_grace_ms`.
- `validateSetting(key, value)` — returns `{ ok, error }`.

**`routes-settings.js`** extended:
- `PATCH /api/settings` validates tier aliases for embedding model fields via `validateSetting()`.
- New settings fields exposed.

**`routes-activity.js`** extended — cursor-based pagination:
- `GET /api/activity?cursor=<runId>&limit=<n>` returns a page of `task_runs` rows sorted by `created_at DESC`.
- Response includes `{ runs: [...], nextCursor: <runId>|null }`.

**`Activity.jsx`** — new paginated Activity page:
- Paginated run history with status chips (`complete`, `failed`, `cancelled`, `skipped`).
- Model + effort badges on each run row.
- "Load more" button advances the cursor.
- SSE subscription for `task_run_*` events auto-prepends new runs to the top of the list.

**`Settings.jsx`** extended:
- Embedding model picker (text input, validated against discovered models).
- Consolidation hour selector (0–23).
- Provider encryption key status: fingerprint shown if key is present; warning if missing.
- Journal tail lines, KB pinned limit, worker timeout, cancel grace period.

**`Knowledge.jsx`** extended:
- Search box wired to `GET /api/search?q=...&type=kb`.
- Results rendered below the existing KB list with excerpts and relevance scores.

**Acceptance criteria:**
- `worklab install-service` on macOS creates `~/Library/LaunchAgents/com.worklab.coordinator.plist` and the process survives a `launchctl unload` / `launchctl load` cycle.
- Same on Linux: `~/.config/systemd/user/worklab.service` created, `systemctl --user status worklab` shows active.
- `worklab backup` produces a `.tar.gz` that can be extracted + `worklab start` to restore the board intact.
- `worklab doctor` reports both embedding backend and encryption key status without crashing when either is absent.
- Activity page loads, shows paginated history, and prepends new runs via SSE.
- Knowledge page search returns results for a query that matches a KB entry.
- 64 backup-service tests + updated settings/activity tests pass.

---

## Verification

After all tasks complete:

```bash
# Full test suite
npm test
# Expected: 401 tests, 0 failing

# Nightly consolidation smoke:
# 1. Ensure an agent has >0 journal entries
# 2. POST http://localhost:7878/api/agents/<name>/consolidate
# 3. Response: { runId: "<id>" }
# 4. Poll GET /api/activity?limit=5 — consolidate run appears with status=complete
# 5. cat data/agents/<name>/MEMORY.md — new Procedures/Facts/Gotchas content

# Semantic search smoke:
# 1. Create a KB entry with body "The deploy command is: make deploy"
# 2. GET http://localhost:7878/api/search?q=deploy+command
# 3. Response includes that KB entry with excerpt

# Service install (macOS):
worklab install-service
launchctl list | grep worklab
# → worklab coordinator process running
open http://localhost:7878/#/tasks
# → board intact

# Backup + restore:
worklab backup
# → ~/worklab-backups/worklab-<timestamp>.tar.gz created
mkdir /tmp/restore-test && tar -xzf ~/worklab-backups/worklab-*.tar.gz -C /tmp/restore-test
WORKLAB_DATA_DIR=/tmp/restore-test worklab start
# → board state matches original

# Doctor checks:
worklab doctor
# → embedding backend: OK (nomic-embed-text, 768 dims, <50ms)
# → encryption key: OK (fingerprint: abc123...)
```

---

## What Phase 6+ will explore

See `docs/plans/phase-6-roadmap.md` for the full list of Phase 6+ candidates.

Likely themes from spec §2 non-goals:

- **Scheduled / recurring tasks** — cron expressions on task definitions; coordinator auto-creates run on schedule.
- **Cost budgets** — per-agent and global daily/weekly spend limits; block runs that would exceed budget.
- **Skill lab** — AI-authored skills with human approval gate; skill versioning and rollback.
- **Workflow chains** — task A completion auto-creates task B with templated input.
- **Cloud backup / sync** — S3 or Backblaze B2 upload target for `worklab backup`.
- **Desktop shell** — Electron or Tauri wrapper for true background service + tray icon on macOS/Windows.
