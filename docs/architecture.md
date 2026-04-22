# Architecture

worklab is a local AI task-execution system: a human creates tasks, assigns
agents, and worklab orchestrates short-lived worker subprocesses that call
language models and built-in/MCP tools to complete and review the work.

---

## 1. Process topology

```
┌─────────────────────────────────────────────────────────────┐
│ Coordinator  (long-lived Node process, default :7878)       │
│                                                             │
│  Express app  ─── REST API + SSE /api/events/stream         │
│  SQLite (WAL)  ── single DB file  data/worklab.db           │
│  task-watcher  ── active-run registry + state transitions   │
│  consolidation-cron ── ticks every 60 s, fires at cron hour │
│  search-indexer ── chokidar FS watcher → embeddings table   │
└──────────────────┬──────────────────────────────────────────┘
                   │  node src/worker.js (per run)
          ┌────────▼────────┐
          │   Worker        │  short-lived subprocess
          │  --mode execute │  stdout: line-delimited JSON events
          │  --mode review  │  stderr: debug logs only
          │  --mode consol. │  exit code: 0/1/2/130
          └────────┬────────┘
                   │  stdio MCP child processes (per worker)
          ┌────────▼────────┐
          │  worklab MCP    │  journal_append/summary, memory_read,
          │  server + any   │  kb_*, *_search — each handler opens
          │  user MCP cfgs  │  its own DB connection
          └─────────────────┘
```

**Coordinator** (`src/coordinator.js`) boots once: seeds `data/` from
`data-template/` on first run, opens SQLite, creates the Express server,
attaches the task-watcher and consolidation manager, starts the search
indexer, then listens on `config.port`. It writes `data/.coordinator.pid`
and removes it on graceful shutdown.

**Worker** (`src/worker.js`) is a short-lived subprocess per run. It
emits line-delimited JSON to stdout; the coordinator reads every line via
`readline` in `spawn-worker.js`. No shared memory, no IPC socket — only
stdout, exit code, and the shared SQLite file.

---

## 2. Source layout

| Path | Responsibility |
|------|----------------|
| `src/coordinator.js` | Boot sequence, wires all subsystems, HTTP listen |
| `src/coordinator/task-watcher.js` | Reducer-driven run orchestration, side-effect application |
| `src/coordinator/spawn-worker.js` | `child_process.spawn`, stdout readline, DB writes on exit |
| `src/coordinator/consolidation-cron.js` | 60 s tick loop, once-per-day consolidate per agent |
| `src/coordinator/search-indexer.js` | chokidar watcher, debounced re-embedding on file changes |
| `src/worker.js` | execute / review / consolidate modes; emits JSON to stdout |
| `src/core/state-machine.js` | Pure reducer: `nextStatus(current, event)` → `{status, sideEffects}` |
| `src/core/ai.js` | `resolveModel`, `generateResponse` — SDK dispatch entry point |
| `src/core/ai-claude.js` | Claude Agent SDK path |
| `src/core/ai-openai.js` | OpenAI Agents SDK path |
| `src/core/ai-vercel.js` | Vercel AI SDK path (Ollama, OpenAI-compat, etc.) |
| `src/core/ai-tool-helpers.js` | Shared tool normalisation across SDK paths |
| `src/core/context.js` | System prompt assembler for execute / review / consolidate |
| `src/core/providers.js` | Provider + model CRUD, URL allowlist, model discovery, Vercel client factory |
| `src/core/crypto.js` | AES-256-GCM encrypt/decrypt, HKDF key derivation |
| `src/core/kb.js` | Knowledge-base CRUD (frontmatter markdown files) |
| `src/core/embeddings.js` | Hybrid FTS5 + vector search; `indexPath`, `indexAllSources`, `search` |
| `src/core/review.js` | `parseVerdict(finalText)` — extracts APPROVE/REJECT from reviewer output |
| `src/core/review-exec.js` | Extracts execution summary from prior-run events for review prompt |
| `src/core/schema.js` | SQLite DDL (schema version 3) |
| `src/core/settings.js` | Key/value settings table read/write |
| `src/core/journal.js` | Append-only JOURNAL.md helpers, `readJournalTail`, `writeMemory` |
| `src/core/skills.js` | Load and index skill playbooks from `data/skills/` |
| `src/core/mcp-config.js` | Load `data/config/mcp.json`, merge built-in MCP server definitions |
| `src/core/db.js` | SQLite singleton (WAL mode), migration runner |
| `src/core/logger.js` | Pino logger |
| `src/core/config.js` | Env-var loading, path resolution |
| `src/core/first-boot.js` | `seedDataFromTemplate` — one-shot copy of `data-template/` → `data/` |
| `src/api/server.js` | Express app factory, SSE broker, route registration |
| `src/api/routes-*.js` | REST handlers: tasks, agents, kb, providers, models, search, runs, activity, settings, skills, mcp |
| `src/api/sse.js` | `createSseBroker` — per-channel SSE fan-out |
| `src/mcp/worklab-tools.js` | Built-in MCP tool handlers + Zod schemas |
| `src/cli/` | `worklab <subcommand>` CLI (start, stop, status, doctor, backup, install-service) |
| `src/ui/` | Preact + Vite PWA; built in Docker multi-stage, served from `src/ui/dist/` |
| `src/__tests__/` | Vitest test suites (unit, API, coordinator, MCP, e2e) |

---

## 3. Data flows

### 3.1 Human creates and runs a task

1. User clicks **Run** in the UI → `POST /api/tasks/:id/run`
   (`src/api/routes-tasks.js`).
2. Route calls `watcher.handleRunRequested(taskId)`
   (`src/coordinator/task-watcher.js:90`).
3. Watcher fetches the task row, calls `nextStatus("todo", {type:"run_requested", executorAgent})`
   (`src/core/state-machine.js:9`). Reducer returns `{status:"in_progress", sideEffects:[{type:"spawn_executor"}]}`.
4. `applySideEffects` / `applyTx` writes `status = in_progress` to SQLite in
   one transaction; `broker.broadcast("global", {type:"task_updated"})` fires
   after commit (`task-watcher.js:85–88`).
5. Watcher inserts a `task_runs` row, calls `spawnWorker({binary: workerBinary,
   args:["--task",id,"--mode","execute","--agent",agentName], env:{WORKLAB_RUN_ID,...}})`
   (`task-watcher.js:114` → `spawn-worker.js`).
6. `spawn-worker.js` forks `node src/worker.js` with `stdio:["ignore","pipe","pipe"]`.
   A `readline` interface on `child.stdout` parses each JSON line; every event
   is pushed to `broker.broadcast(runId, parsed)` for SSE subscribers
   (`spawn-worker.js:29–42`).
7. Worker emits `{type:"started"}`, then calls `generateResponse(...)` which
   drives the agent loop (`src/worker.js:95–204`).
8. On worker exit, `spawn-worker.js` writes final `task_runs` and `agent_logs`
   rows, resolves the `done` promise (`spawn-worker.js:57–103`).
9. `task-watcher.onWorkerExit` calls `handleExecuteExit` which calls
   `nextStatus("in_progress", {type:"run_completed", reviewerAgent})`
   → `{status:"in_review", sideEffects:[{type:"spawn_reviewer"}]}` if a
   reviewer is configured; otherwise status stays `in_review` with no spawn
   (`task-watcher.js:203–255`).

### 3.2 Reviewer loop (in_progress → in_review → done / in_progress)

1. `spawnReviewer(taskId, reviewerAgent, priorRunId)` is called immediately
   after the execute worker exits successfully (`task-watcher.js:158`).
2. Worker starts with `--mode review`. It reads `WORKLAB_PRIOR_RUN_ID` from
   env, fetches the prior `agent_logs` row, calls `extractExecutionFromEvents`
   (`src/core/review-exec.js`) to build an execution summary, then calls
   `buildReviewSystemPrompt` with that summary appended (`src/core/context.js:80`).
3. Worker emits a `{type:"verdict", verdict:"APPROVE"|"REJECT", notes}` event
   before emitting `{type:"final"}` (`src/worker.js:268–269`).
4. On exit, `handleReviewExit` (`task-watcher.js:258`) first checks for a
   structured `verdict` event in `res.events`; falls back to `parseVerdict(res.finalText)`
   from `src/core/review.js:14`.
   - **APPROVE** → `nextStatus("in_review", {type:"review_approved"})` →
     `{status:"done", sideEffects:[{type:"set_completed_at"}]}`.
   - **REJECT** → `nextStatus("in_review", {type:"review_rejected", notes})` →
     `{status:"in_progress", sideEffects:[{type:"post_review_comment"}, {type:"clear_error_text"}]}`.
     The rejection notes become a system `task_comments` row.
   - **Parse failure** (verdict `null`) → task stays `in_review`, `error_text`
     is set to "Reviewer did not emit a VERDICT line"
     (`task-watcher.js:319–330`).

### 3.3 Consolidation tick

`consolidation-cron.js` sets a 60 s `setInterval` (`TICK_MS = 60_000`,
line 9). On each tick it reads `settings.consolidation_hour` and the local
wall-clock hour. When they match (and the date has not been processed yet),
`tick()` iterates all enabled agents and calls `runNow(agentName, {force:false})`
for each one whose `JOURNAL.md` SHA-256 hash differs from the stored
`last_journal_hash` in `agent_consolidations`.

`runNow` spawns `node src/worker.js --mode consolidate --agent <name>`.
The worker calls `buildConsolidationSystemPrompt` (role + full journal +
current memory) and `generateResponse` with `maxTurns:10` and an empty tool
set (journal writes are disallowed). On success it calls `writeMemory` to
overwrite `data/agents/<name>/MEMORY.md`, emits `{type:"memory_written"}`,
then emits `{type:"final"}`. The coordinator records the new journal hash
in `agent_consolidations` and triggers `indexPath` on the new `MEMORY.md`
(`consolidation-cron.js:48–50`).

### 3.4 Filesystem watcher → embeddings

`startSearchIndexer` (`src/coordinator/search-indexer.js`) uses chokidar to
watch three glob patterns at startup:

```
data/knowledge/*.md
data/agents/*/JOURNAL.md
data/agents/*/MEMORY.md
```

Changes (`add`, `change`, `unlink`) are debounced by 500 ms per file path.
Each debounce fires `indexPath({db, dataDir, filePath})` from
`src/core/embeddings.js`, which:
1. Reads the file, chunks it (`MAX_CHUNK_CHARS = 1800`).
2. Hashes the content; skips re-embedding if unchanged.
3. Optionally calls an embedding model (if configured) and stores the float
   vector as a `BLOB` in the `embeddings` table.
4. Upserts the `embeddings_fts` FTS5 virtual table row in the same operation.

On coordinator start an `indexAllSources` scan runs once to catch any files
changed while the process was not running.

### 3.5 Multi-SDK dispatch

`resolveModel(value)` in `src/core/ai.js:60` calls `parseModelReference`:

- `claude:<modelId>` → `{sdk:"claude", model:...}` → `ai-claude.js`
- `openai:<modelId>` → `{sdk:"openai", model:...}` → `ai-openai.js`
- `vercel:<providerId>:<modelName>` → `{sdk:"vercel", providerId:..., modelName:...}` → `ai-vercel.js`

`generateResponse(systemPrompt, options)` in `ai.js:64` dynamic-imports the
matching module at call time. Each SDK module wraps its streaming API in a
normalised return shape `{text, usage, model, effort, durationMs, numTurns,
cancelled, error}`. MCP servers and built-in tools are merged in
`src/core/ai-tool-helpers.js`.

For the Vercel path, `resolveVercelModel` (`src/core/providers.js:378`)
looks up the custom provider row, decrypts the API key
(`src/core/crypto.js`), and calls `createVercelClient` to produce a model
factory (Ollama native or OpenAI-compat).

### 3.6 Pinned KB injection

`kbListPinned({dataDir, limit})` (from `src/core/kb.js`) loads up to
`settings.kb_pinned_limit` (default 10) entries with `pinned: true` from
`data/knowledge/`. The worker reads this list in `loadCommonSetup`
(`src/worker.js:67–70`) and passes it to both `buildExecuteSystemPrompt`
and `buildReviewSystemPrompt` as a **Pinned knowledge** section
(`src/core/context.js:69, 83`). Consolidation prompts do not include pinned KB.

---

## 4. Core abstractions

**Pure reducer (`src/core/state-machine.js`)** — all legal status transitions
flow through `nextStatus(current, event)` which returns `{status, sideEffects}`.
It never touches the DB or network. The coordinator (`task-watcher.js:85`)
interprets the returned side effects: `set_completed_at`, `clear_completed_at`,
`clear_error_text`, `set_error_text`, `post_error_comment`, `post_review_comment`
are applied in a single SQLite transaction via `applyTx`. `spawn_executor`
and `spawn_reviewer` are handled by the calling function after the transaction
commits.

**SSE broker (`src/api/sse.js`)** — `broker.broadcast(channel, event)` fans
out JSON-stringified events to all active SSE response objects on that
channel. The `global` channel carries task/agent lifecycle events; per-`runId`
channels carry fine-grained SDK streaming events (text chunks, tool calls,
usage). The UI subscribes to `GET /api/events/stream`.

**MCP tool server (`src/mcp/worklab-tools.js`)** — `createToolHandlers(context)`
returns async handlers for: `journal_append`, `journal_summary`, `memory_read`,
`kb_create`, `kb_update`, `kb_delete`, `kb_read`, `kb_list`, `kb_search`,
`journal_search`, `memory_search`. Each handler that touches KB opens a
short-lived DB connection via `withDb` so writes are safe from the MCP
subprocess. The built-in server is launched as a stdio child of the worker
via `src/core/mcp-config.js`; context (agent name, run ID, task ID) is
injected as env vars.

**Verdict parsing (`src/core/review.js:14`)** — `parseVerdict(finalText)`
scans the final text for the first non-blank line matching
`/^\s*VERDICT:\s*(APPROVE|REJECT)\b/`. REJECT collects everything after
the verdict line as `notes`. Returns `{verdict: null, notes:""}` on parse
failure; the coordinator treats `null` as a soft error (task stays
`in_review`, `error_text` is set).

**Provider dispatch and URL allowlist (`src/core/providers.js`)** —
`validateBaseUrl` permits RFC 1918 CIDRs (`10/8`, `172.16/12`, `192.168/16`),
Tailscale (`100.64/10`), loopback (`127/8`), and named localhost. Public hosts
require `trust_public_url: true` AND HTTPS. API keys are stored encrypted
(`src/core/crypto.js`): AES-256-GCM with a 256-bit HKDF-derived key. The
master key is read from `PROVIDER_ENCRYPTION_KEY` env or auto-generated on
first boot at `data/.provider-encryption-key` (0600 perms).

---

## 5. Storage model

### 5.1 SQLite schema (schema version 3, `src/core/schema.js`)

| Table | Purpose |
|-------|---------|
| `schema_meta` | Schema version bookkeeping |
| `agents` | Agent definitions: model reference, effort, instructions, allowlists |
| `tasks` | Task records: title, description, instructions, status, agent assignments |
| `task_comments` | Per-task comment thread (human, agent, system authors) |
| `task_runs` | One row per worker invocation: mode, PID, status, timing, exit code |
| `agent_logs` | Aggregated metrics per run: events JSON, token counts, cost, duration |
| `custom_providers` | User-registered model providers (Ollama, OpenAI-compat) |
| `custom_models` | Models discovered within a provider; capabilities + pricing cache |
| `embeddings` | Per-chunk text + optional float32 vector BLOB + FTS5 mirror |
| `embeddings_fts` | FTS5 virtual table (id, kind, source_ref, title, chunk_text) |
| `agent_consolidations` | Last journal SHA-256 hash + timestamp per agent |
| `settings` | Key/value store for runtime configuration |

The DB uses `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.

### 5.2 Filesystem as source of truth

| Path | Nature |
|------|--------|
| `data/knowledge/<slug>.md` | Canonical KB entries with YAML frontmatter; DB indexes are derived |
| `data/agents/<name>/JOURNAL.md` | Append-only bullet journal; never rewritten |
| `data/agents/<name>/MEMORY.md` | Rewritten by consolidation worker; AI-managed summary |
| `data/skills/<name>/SKILL.md` | Skill playbooks loaded by the worker at run time |
| `data/config/mcp.json` | Additional MCP server definitions (Claude Desktop format) |

Deleting the DB and running `worklab start` rebuilds the indexes from the
filesystem (enforced by tests). The filesystem is always authoritative for
KB, journal, memory, and skills.

### 5.3 `data-template/` vs `data/`

`data-template/` is git-tracked and contains the factory defaults (example
agent, example skill, welcome KB entry). On first boot, `seedDataFromTemplate`
(`src/core/first-boot.js`) copies it to `data/` if and only if `data/` is
empty or absent. `data/` is gitignored; it is the live runtime state for the
running instance.

---

## 6. Security model

**YOLO mode** — workers run with `permissionMode: "bypassPermissions"` and
have access to the full built-in tool set (Read, Write, Edit, Glob, Grep,
Bash, WebFetch, WebSearch) unless the agent's `builtin_allowlist` restricts
them. There is no sandbox. This is a deliberate trade-off for a local
single-user tool (documented in the spec §9); the user is responsible for
the instructions they give their agents.

**URL allowlist for providers** — `validateBaseUrl` in `src/core/providers.js:61`
enforces that custom provider base URLs point at private hosts (RFC 1918,
Tailscale, localhost) unless `trust_public_url: true` is set. Public URLs
additionally require HTTPS.

**API key encryption** — provider API keys are encrypted with AES-256-GCM
before storage in `custom_providers.api_key_encrypted`. The 256-bit key is
derived via HKDF-SHA-256 from a master key stored at
`data/.provider-encryption-key` (mode 0600, auto-generated on first boot)
or overridden by `PROVIDER_ENCRYPTION_KEY` env (`src/core/crypto.js`).

**Single-user localhost by default** — no auth. The coordinator listens on
`127.0.0.1` by default. Exposing it beyond localhost (Tailscale, reverse
proxy with auth) is the user's responsibility.

---

## 7. Testing model

Tests live under `src/__tests__/` and run with Vitest.

| Directory | What it tests |
|-----------|---------------|
| `src/__tests__/core/` | Pure modules: state-machine, review, crypto, providers, embeddings, kb, context, ai dispatch |
| `src/__tests__/api/` | REST routes via supertest against an in-memory SQLite DB |
| `src/__tests__/coordinator/` | task-watcher and consolidation-cron with stubbed spawn |
| `src/__tests__/mcp/` | worklab-tools handlers invoked directly |
| `src/__tests__/e2e/` | Full HTTP + DB + fake-worker subprocess |
| `src/__tests__/helpers/` | Shared fixtures: `test-db.js`, `test-server.js`, fake-worker |
| `src/__tests__/smoke.test.js` | Multi-SDK dispatch smoke (all three SDK paths) |

Coverage thresholds (vitest `coverage`): 60 % lines / functions / branches /
statements across `src/` (excluding `src/__tests__/` and `src/ui/`).

---

## 8. Where to extend

- **New REST route** — add `src/api/routes-<name>.js` and call
  `register<Name>Routes(app, ...)` in `src/api/server.js`.
- **New MCP tool** — add handler + Zod schema to `src/mcp/worklab-tools.js`
  and extend `toolDefinitions` in the same file.
- **New SDK backend** — implement `src/core/ai-<name>.js` exporting
  `generate<Name>Response(systemPrompt, options)`, add a branch in
  `generateResponse` in `src/core/ai.js`, and register a new `sdk` prefix
  in `parseModelReference`.
- **New agent mode** — add the new event/transition to `src/core/state-machine.js`,
  add a prompt builder to `src/core/context.js`, add a branch in
  `src/worker.js`, and add an exit handler in `src/coordinator/task-watcher.js`.
- **New UI route** — add a `<Route>` in `src/ui/src/App.jsx` and a component
  under `src/ui/src/routes/`.
