> Canonical product spec. Copied 2026-04-22 from the workspace spec at `/opt/claude-workspace/docs/superpowers/specs/2026-04-21-worklab-design.md`.

# Worklab — Product Requirements Document

**Status:** Draft
**Date:** 2026-04-21
**Owner:** Robert
**Scope:** v1 (Approach 2 envelope — see §2)

---

## 1. Executive summary

Worklab is a local-only, single-user AI agent orchestration tool for work. It runs on the user's laptop (macOS or Linux), serves a web UI on `localhost`, and coordinates multiple configurable AI agents that execute kanban-style work tasks. It reuses the primitives proven in Mickey AI (Agent SDK runtime, skills system, MCP config loader, filesystem-as-memory) and drops the consumer-facing surfaces (WhatsApp/Telegram transports, personality evolution, relationship arcs).

The user assigns an executor agent and optionally a reviewer agent to each task, provides free-text instructions, and either drags the task into `in_progress` or clicks "Run now." A worker subprocess executes the task with full, unrestricted host access (YOLO mode — `permissionMode: bypassPermissions`), streams its thinking and tool calls to the task detail view live, and exits. The coordinator flips the task to `in_review`, where a reviewer agent (if assigned) auto-runs and either approves (→ `done`) or rejects (→ back to `in_progress` with notes). Agents journal as they work and consolidate nightly into long-term memory; agents publish to a shared knowledge base and search it via MCP tools.

Worklab is greenfield code — no fork, no shared package with Mickey AI. Snippets may be copied by hand where useful.

---

## 2. Goals and non-goals

### Goals (v1)
- Run entirely on localhost. No auth, no reverse proxy, no Docker.
- CLI-first, with opt-in `worklab install-service` to background-install as launchd (macOS) or systemd user unit (Linux).
- Kanban task board with four columns: `todo`, `in_progress`, `in_review`, `done`.
- Configurable agents: SDK (Claude / OpenAI / Vercel), model, effort, instructions, skill allowlist, MCP server allowlist, built-in tool allowlist.
- YOLO execution: `permissionMode: bypassPermissions`, unrestricted filesystem, default `cwd = ~/worklab-workspace/`.
- Folder-based skills with YAML frontmatter (same format as Mickey AI's skills).
- Shared filesystem knowledge base with create/update/delete/read/search MCP tools, humans and agents both write.
- Per-agent bullet journal (append-only during task execution) + consolidated `MEMORY.md` (rewritten nightly + on-demand).
- Multi-SDK support with custom provider registry and AES-256-GCM-encrypted API keys.
- Local semantic search over KB and journals (default Ollama `nomic-embed-text`, configurable).
- Per-task live event stream in the UI via SSE.

### Non-goals (v1, deferred to later)
- Authentication (not exposed outside the host).
- Recurring / scheduled / cron tasks.
- Cost budgets or enforcement (cost is displayed, not enforced).
- Desktop app shell (Electron/Tauri).
- Workflow chains (task A's output auto-creates task B).
- Backup-to-cloud / sync.
- Skill lab (AI-authored skills with human approval).
- Team / multi-user features.
- Windows support (macOS + Linux only for v1).

---

## 3. Architecture

### 3.1 Process topology

Two processes:

**Coordinator** (`node src/coordinator.js`, one long-lived instance):
- Serves the web UI and JSON API on `http://localhost:<port>` (default `7878`).
- Owns the single SQLite connection (WAL mode).
- Watches task state transitions and spawns workers.
- Tracks `{taskId → workerPid}` map for cancellation.
- Broadcasts SSE events (`/api/runs/:id/stream`, `/api/events/stream`).
- Runs the nightly consolidation cron.
- Exits on `SIGTERM`/`SIGINT`; leaves running workers to finish naturally unless told otherwise.

**Worker** (`node src/worker.js --task <id> --mode <execute|review|consolidate> [--agent <name>]`, spawned per run, dies when done):
- One worker = one run. Fresh Node process. No reuse.
- Reads task + agent config from DB/filesystem at startup.
- Calls the SDK; streams line-delimited JSON events to `stdout`.
- Writes journal entries via MCP tool calls during the run.
- Exits with a code — `0` = clean completion, nonzero = error.

The coordinator spawns workers with `child_process.spawn`, pipes `stdout`/`stderr` through a line-splitter, parses each line as JSON (malformed lines logged at warn level and discarded), broadcasts to SSE subscribers, and appends to `agent_logs.events`. No IPC beyond stdout lines + exit codes + DB rows.

### 3.2 Directory layout (repo)

```
worklab/
├── package.json
├── README.md
├── vitest.config.js
├── .gitignore                    (excludes data/, !data-template/)
├── src/
│   ├── coordinator.js            (coordinator entrypoint)
│   ├── worker.js                 (worker entrypoint)
│   ├── cli/
│   │   ├── index.js              (worklab bin dispatcher)
│   │   ├── start.js
│   │   ├── stop.js
│   │   ├── status.js
│   │   ├── install-service.js
│   │   ├── uninstall-service.js
│   │   ├── backup.js
│   │   └── doctor.js
│   ├── core/
│   │   ├── ai.js                 (resolveModel, generateResponse, dispatches to sdk-*)
│   │   ├── ai-claude.js          (Claude Agent SDK path)
│   │   ├── ai-openai.js          (OpenAI Agents SDK path)
│   │   ├── ai-vercel.js          (Vercel AI SDK path)
│   │   ├── db.js                 (singleton, schema, migrations)
│   │   ├── crypto.js             (AES-256-GCM, HKDF master key)
│   │   ├── providers.js          (URL allowlist, discovery, decrypt)
│   │   ├── skills.js             (frontmatter parser, loader)
│   │   ├── mcp-config.js         (config loader, validator, built-in servers)
│   │   ├── context.js            (system prompt assembler)
│   │   ├── journal.js            (atomic append, read/parse)
│   │   ├── memory.js             (read/write MEMORY.md)
│   │   ├── kb.js                 (KB CRUD, frontmatter, search)
│   │   ├── embeddings.js         (embed + semantic search)
│   │   ├── state-machine.js      (pure reducer for task transitions)
│   │   ├── logger.js             (pino setup)
│   │   └── config.js             (env loading, defaults)
│   ├── mcp/
│   │   ├── launch-worklab-mcp.sh (entrypoint for built-in stdio server)
│   │   ├── worklab-tools.js      (journal_append, kb_*, memory_*, etc.)
│   │   └── response.js
│   ├── api/
│   │   ├── server.js             (Express app factory)
│   │   ├── sse.js                (SSE broker)
│   │   ├── routes-tasks.js
│   │   ├── routes-agents.js
│   │   ├── routes-skills.js
│   │   ├── routes-kb.js
│   │   ├── routes-providers.js
│   │   ├── routes-mcp.js
│   │   ├── routes-settings.js
│   │   └── routes-activity.js
│   ├── coordinator/
│   │   ├── spawn-worker.js       (worker spawn + event demux)
│   │   ├── task-watcher.js       (state-change reactor)
│   │   ├── consolidation-cron.js (nightly scheduler)
│   │   └── cancel.js             (SIGTERM → SIGKILL)
│   ├── ui/                       (Preact+Vite app)
│   │   ├── index.html
│   │   ├── vite.config.js
│   │   ├── src/
│   │   │   ├── main.jsx
│   │   │   ├── App.jsx
│   │   │   ├── routes/
│   │   │   │   ├── Kanban.jsx
│   │   │   │   ├── TaskDetail.jsx
│   │   │   │   ├── Agents.jsx
│   │   │   │   ├── AgentEdit.jsx
│   │   │   │   ├── Skills.jsx
│   │   │   │   ├── SkillEdit.jsx
│   │   │   │   ├── Knowledge.jsx
│   │   │   │   ├── KbEdit.jsx
│   │   │   │   ├── Providers.jsx
│   │   │   │   ├── Activity.jsx
│   │   │   │   └── Settings.jsx
│   │   │   ├── components/       (Card, Modal, MarkdownEditor, SSEStream, etc.)
│   │   │   └── lib/              (api client, useSSE hook)
│   │   └── dist/                 (build output, served by coordinator)
│   └── __tests__/
│       ├── helpers/
│       │   ├── mock-db.js
│       │   └── fake-worker.js
│       ├── core/                 (unit)
│       ├── api/                  (integration)
│       └── e2e/                  (smoke)
├── data-template/                (git-tracked seed for first boot)
│   ├── config/
│   │   └── mcp.json              ({ "mcpServers": {} })
│   ├── skills/
│   │   └── example/
│   │       └── SKILL.md
│   └── knowledge/
│       └── welcome.md
└── scripts/
    └── generate-launchd-plist.js (helper for install-service)
```

### 3.3 Data directory layout (runtime, `data/`, gitignored)

```
data/
├── worklab.db
├── worklab.db-wal
├── worklab.db-shm
├── .provider-encryption-key      (0600, auto-generated on first boot)
├── config/
│   └── mcp.json                  (global MCP server registry)
├── agents/
│   └── <agent-name>/
│       ├── JOURNAL.md            (append-only bullet journal)
│       └── MEMORY.md             (consolidated long-term memory)
├── skills/
│   └── <skill-name>/
│       ├── SKILL.md              (YAML frontmatter + playbook)
│       └── <assets>              (optional files referenced by the skill)
├── knowledge/
│   └── <slug>.md                 (YAML frontmatter + body)
└── logs/
    ├── coordinator.log
    └── workers/
        └── <run-id>.log
```

The filesystem is the source of truth for human-readable content (skills, KB, journals, memory). SQLite stores structured records, indexes (embeddings, FTS), and encrypted secrets. Deleting the DB and rebuilding indexes from the filesystem must be possible (enforced by test).

---

## 4. Data model

### 4.1 SQLite schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE agents (
  name                TEXT PRIMARY KEY,        -- stable identifier (slug, lowercase, hyphens)
  display_name        TEXT NOT NULL,
  description         TEXT,
  sdk                 TEXT NOT NULL,           -- "claude" | "openai" | "vercel"
  model               TEXT NOT NULL,           -- e.g. "sonnet" | "opus" | "vercel:<providerId>:<modelName>"
  effort              TEXT NOT NULL DEFAULT 'medium', -- "low"|"medium"|"high"|"xhigh"|"max"
  instructions        TEXT NOT NULL DEFAULT '',-- free-text system-prompt body
  skills_allowlist    TEXT NOT NULL DEFAULT '[]',-- JSON array of skill names, [] = all enabled skills
  mcp_allowlist       TEXT NOT NULL DEFAULT '[]',-- JSON array of MCP server names, [] = all registered servers
  builtin_allowlist   TEXT NOT NULL DEFAULT '[]',-- JSON array of built-in tool names, [] = all built-ins
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,        -- nanoid(21)
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',-- markdown, "what" + context
  instructions        TEXT NOT NULL DEFAULT '',-- markdown, directives to the executor
  status              TEXT NOT NULL DEFAULT 'todo', -- 'todo'|'in_progress'|'in_review'|'done'
  executor_agent      TEXT REFERENCES agents(name) ON DELETE SET NULL,
  reviewer_agent      TEXT REFERENCES agents(name) ON DELETE SET NULL,
  priority            INTEGER NOT NULL DEFAULT 0, -- 0=normal, 1=high, -1=low
  tags                TEXT NOT NULL DEFAULT '[]',-- JSON array
  error_text          TEXT,                    -- last error summary (cleared on successful retry)
  retry_count         INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX idx_tasks_status ON tasks(status, updated_at DESC);

CREATE TABLE task_comments (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_type         TEXT NOT NULL,           -- 'human' | 'agent' | 'system'
  author_id           TEXT,                    -- agent name, or null for human/system
  body                TEXT NOT NULL,           -- markdown
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_comments_task ON task_comments(task_id, created_at);

CREATE TABLE task_runs (
  id                  TEXT PRIMARY KEY,        -- nanoid(21), used as SSE channel id
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL,           -- 'execute' | 'review' | 'consolidate'
  agent_name          TEXT NOT NULL,
  worker_pid          INTEGER,
  status              TEXT NOT NULL DEFAULT 'running', -- 'running'|'complete'|'error'|'cancelled'
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  exit_code           INTEGER,
  error_text          TEXT
);
CREATE INDEX idx_runs_task ON task_runs(task_id, started_at DESC);

CREATE TABLE agent_logs (
  id                  TEXT PRIMARY KEY,
  task_run_id         TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  events              TEXT NOT NULL,           -- JSON array of SDK events
  model               TEXT,
  effort              TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd            REAL,
  duration_ms         INTEGER,
  num_turns           INTEGER,
  status              TEXT NOT NULL,           -- 'complete'|'error'|'cancelled'
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_logs_run ON agent_logs(task_run_id);

CREATE TABLE custom_providers (
  id                  TEXT PRIMARY KEY,        -- nanoid(12)
  name                TEXT NOT NULL UNIQUE,    -- user-friendly ("my-ollama")
  provider_type       TEXT NOT NULL,           -- 'ollama' | 'openai_compat'
  base_url            TEXT NOT NULL,
  api_key_encrypted   TEXT,                    -- base64(iv||ciphertext||tag), null for no-auth
  trust_public_url    INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE custom_models (
  id                  TEXT PRIMARY KEY,
  provider_id         TEXT NOT NULL REFERENCES custom_providers(id) ON DELETE CASCADE,
  model_name          TEXT NOT NULL,           -- raw provider id, e.g. "gemma3:4b"
  alias               TEXT,                    -- optional user-friendly label
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  UNIQUE(provider_id, model_name)
);

CREATE TABLE embeddings (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,           -- 'kb' | 'journal' | 'memory'
  ref                 TEXT NOT NULL,           -- e.g. "knowledge/<slug>.md#chunk-3" or "agents/<name>/JOURNAL.md#2026-04-21T14:32:00Z"
  chunk_text          TEXT NOT NULL,
  vector              BLOB NOT NULL,           -- Float32Array bytes
  model               TEXT NOT NULL,           -- embedding model id
  created_at          INTEGER NOT NULL,
  UNIQUE(kind, ref)
);
CREATE INDEX idx_embeddings_kind ON embeddings(kind);

CREATE TABLE settings (
  key                 TEXT PRIMARY KEY,
  value               TEXT NOT NULL            -- JSON-encoded
);
```

### 4.2 Filesystem file formats

**Skill file** (`data/skills/<name>/SKILL.md`):
```markdown
---
name: slack-weekly-update
trigger: "when composing a weekly leadership update from Slack activity"
enabled: true
priority: always         # optional: "always" inlines full body in every system prompt
---

# Slack Weekly Update Playbook

1. Use `slack_list_messages` with `channel: "general"` and `lookback_days: 7`.
2. Group by theme. Highlight launches and blockers.
3. Post the summary to #leadership-updates with `slack_post`.
```

**Knowledge-base entry** (`data/knowledge/<slug>.md`):
```markdown
---
title: Project Loom quarterly goals
slug: project-loom-quarterly-goals
tags: [project-loom, planning]
category: projects
pinned: false            # if true, included in every agent's system prompt (cap 10 per agent)
author: human            # "human" | agent name
created_at: 2026-04-21T10:15:00Z
updated_at: 2026-04-21T10:15:00Z
---

## Q2 focus

- Ship dark mode.
- Reduce p95 latency below 300ms.
```

**Agent journal** (`data/agents/<name>/JOURNAL.md`, append-only):
```markdown
## 2026-04-21 14:32:07Z — run abc123 — task def456 ("Slack weekly update")
- Pulled last 7d of #general (412 messages).
- Grouped by theme: launches (7), incidents (2), hiring (4).
- Posted summary to #leadership-updates (permalink: https://…).
- Gotcha: skip messages from the @channel bot next time.

## 2026-04-21 14:38:15Z — run abc123 (summary)
- Posted successfully. Took 2 tool turns. No rejections.
```

**Agent memory** (`data/agents/<name>/MEMORY.md`, rewritten on consolidation):
```markdown
# <Agent Display Name> — Long-Term Memory

_Last consolidated: 2026-04-21T03:00:12Z_

## Procedures

- When summarising a Slack channel, always skip @channel and @here bot-noise.
- Posts to #leadership-updates must include a "TL;DR" first line.

## Facts

- Project Loom = dark mode + latency initiative (see kb: project-loom-quarterly-goals).
- #general's signal-to-noise is lowest on Fridays.

## Gotchas

- Slack permalinks require `include_permalink=true` in the tool call.
```

**MCP config** (`data/config/mcp.json`, Claude Desktop shape):
```json
{
  "mcpServers": {
    "worklab": {
      "command": "/abs/path/to/worklab/src/mcp/launch-worklab-mcp.sh"
    },
    "slack": {
      "command": "/usr/local/bin/mcp-slack",
      "env": { "SLACK_TOKEN": "xoxb-..." }
    }
  }
}
```

The `worklab` MCP server is always injected by the worker (not required in `mcp.json`). User-registered servers are extra.

---

## 5. Component specifications

### 5.1 Coordinator

- Entrypoint: `src/coordinator.js`
- Startup: open DB → run migrations → seed `data-template/` if `data/` empty → open HTTP listener → attach task-watcher → attach consolidation cron.
- `POST /api/tasks/:id/run` resolves to inserting a `task_runs` row with `status=running` and calling `spawnWorker({ taskId, mode: 'execute' })`.
- Task-watcher subscribes to its own state-change events (fired by API routes) and reacts:
  - Task transitions to `in_review` → if `reviewer_agent` set, spawn worker with `mode=review`; else no-op.
  - Task transitions to `done` → set `completed_at`, emit `task_updated` SSE.
- Consolidation cron: `node-cron` set to `settings.consolidation_hour` (default 03:00 local). For each enabled agent with at least one new journal entry since last consolidation, spawn `mode=consolidate`.
- SSE broker (`src/api/sse.js`) maintains two channels:
  - `/api/runs/:id/stream` — events for a single run.
  - `/api/events/stream` — global event bus (emits `{type:"task_updated",id}`, `{type:"run_started",runId,taskId}`, etc.).

### 5.2 Worker

- Entrypoint: `src/worker.js`
- Args: `--task <id> --mode execute|review|consolidate [--agent <name>]`
- Startup sequence:
  1. Open DB read-only (prevents accidental writes outside MCP tools).
  2. Load task + agent + skills + MCP config from DB + filesystem.
  3. Emit `{"type":"started","ts":<unix>,"runId":"..."}` to stdout.
  4. Call `ai.generateResponse()` with the assembled context.
  5. As events stream from the SDK, emit one line of JSON per event: `{"type":"sdk_event","event":{...}}`.
  6. On final assistant text, emit `{"type":"final","text":"...","usage":{...}}`.
  7. Flush + exit.
- SIGTERM handler: stop the SDK stream, flush any buffered events, emit `{"type":"cancelled"}`, exit code 130.
- All journal writes happen via MCP tool calls (the worker does not write `JOURNAL.md` directly — the agent does, through the tool).

### 5.3 `src/core/ai.js`

Public API:

```javascript
export function resolveModel(value, sdkHint) { /* ... */ }
// Returns { sdk: "claude"|"openai"|"vercel", model: "<string>", providerId?, modelName?, tier? }

export async function generateResponse(systemPrompt, options) {
  // options:
  //   model: resolved { sdk, model, ... }
  //   effort: "low"|"medium"|"high"|"xhigh"|"max"
  //   messages: [{ role, content }]   // user-side messages
  //   mcpServers: { [name]: { command, args, env } | { type, url, headers } }
  //   allowedTools: string[]
  //   disallowedTools: string[]
  //   permissionMode: "bypassPermissions"
  //   cwd: string
  //   maxTurns: number
  //   onEvent: (event) => void        // every SDK event
  // Returns { text, events, usage, model, effort, durationMs }
}
```

Dispatches by `options.model.sdk` to `ai-claude.js`, `ai-openai.js`, or `ai-vercel.js`.

### 5.4 `src/core/crypto.js`

Mirrors Mickey AI's `crypto.js` module: HKDF-derived master key with context `"worklab/provider-credentials/v1"`. Master key resolution: `PROVIDER_ENCRYPTION_KEY` env → `data/.provider-encryption-key` file → auto-generate + write with `0600`. AES-256-GCM, 12-byte IV, 16-byte tag, base64 output `iv||ciphertext||tag`.

### 5.5 `src/core/providers.js`

- URL allowlist: localhost, RFC1918 (10/8, 172.16/12, 192.168/16), Tailscale CGNAT (100.64/10), 127/8, IPv6 private. Public URLs require `trust_public_url: true` AND HTTPS.
- Model discovery: `GET /v1/models` for `provider_type=openai_compat`, `GET /api/tags` for `ollama`. Returns normalized `[{ id, name, raw }]`.
- Decryption of API keys is scoped to the worker and never logged.

### 5.6 `src/core/skills.js`

- `loadSkills()` walks `data/skills/*/SKILL.md`, parses frontmatter, returns `[{ name, trigger, enabled, priority, body, assetsPath }]`.
- `parseSkillFrontmatter(content)` — pure function, returns `{ meta, body } | null`.
- `buildSkillIndex(allowlist)` — returns the "name + trigger" index string for the system prompt.
- Skills with `priority: always` inlined in full. Others indexed only; agent reads body on demand via the `read_file` tool.

### 5.7 `src/core/mcp-config.js`

- `loadMcpConfig()` reads `data/config/mcp.json`, validates stdio commands are absolute paths, validates remote URLs against allowlist, returns `{ [name]: <server-config> }`.
- `getBuiltinMcpServers()` always returns `{ worklab: { command: "<abs>/src/mcp/launch-worklab-mcp.sh" } }`.
- `pickMcpServers(allowlist)` returns the union of builtin + user-configured, filtered by the agent's allowlist (empty allowlist = all).

### 5.8 `src/mcp/worklab-tools.js` (built-in MCP server)

Tools exposed:

| Tool | Purpose |
|---|---|
| `journal_append(bullet: string)` | Atomically append a timestamped bullet to the running agent's `JOURNAL.md`. |
| `journal_summary(text: string)` | Append a `(summary)` entry at the end of the run. |
| `memory_read()` | Return the full `MEMORY.md` content for the running agent. |
| `kb_create(slug, title, body, tags?, category?, pinned?)` | Create a new `knowledge/<slug>.md`. Fails if slug exists. |
| `kb_update(slug, patch)` | Patch frontmatter and/or body. |
| `kb_delete(slug)` | Delete entry. |
| `kb_read(slug)` | Return full body + frontmatter. |
| `kb_search(query, limit=8)` | Semantic + FTS hybrid. Returns `[{slug, title, snippet, score}]`. |
| `kb_list({tag?, category?, pinned?})` | List entries with filters. |

Each tool validates its inputs with Zod, writes atomically (`writeAtomic`), triggers re-embedding via `embeddings.queue(ref)` when content changes.

The `journal_*` tools infer the agent name from an env var the worker sets (`WORKLAB_AGENT_NAME`) — the agent cannot write to a different agent's journal.

### 5.9 `src/core/context.js`

Assembles the worker's system prompt in this order:

1. **Agent instructions** (`agents.instructions` column) — the user-authored role/goals text.
2. **Pinned KB** — all KB entries with `pinned: true` (cap 10), inlined in full.
3. **Skill index** — one line per enabled skill: `- <name>: <trigger>`. Plus full body for any `priority: always` skills.
4. **Memory** — the agent's `MEMORY.md`.
5. **Journal tail** — the last `settings.journal_tail_lines` (default 80) of `JOURNAL.md`.
6. **Task block** — task title + description + instructions + comment history (rendered as chronological transcript).
7. **Cadence instruction** — the literal string: *"Journal as you work — call `journal_append` for facts you discover, decisions you make, and corrections you learn. At the end of the task, optionally call `journal_summary` if anything rolls up."*

For review mode, the task block is augmented with the executor's final text and the prior agent log summary; the cadence instruction is replaced with: *"Review the executor's work against the task instructions. Respond with a final message whose first line is either `VERDICT: APPROVE` or `VERDICT: REJECT`. If REJECT, follow with bullet-pointed notes the executor can act on."*

For consolidate mode, the prompt is: *"Rewrite `MEMORY.md` using the current journal and existing memory. Organize as Procedures / Facts / Gotchas. Deduplicate. Drop anything older than 90 days unless it's a durable fact. Use `memory_read` to see the current memory."* The worker enforces the mode restriction by stripping `journal_append` and `journal_summary` from the agent's MCP allowlist at launch time for `mode=consolidate`; the agent's final assistant message is parsed and written atomically to `MEMORY.md` by the worker (not by a tool call). This guarantees the journal cannot be mutated during consolidation even if the LLM tries.

### 5.10 `src/core/state-machine.js`

Pure reducer:

```javascript
export function nextStatus(current, event) {
  // event.type: 'run_requested' | 'run_completed' | 'run_failed' | 'review_approved' | 'review_rejected' | 'human_move'
  // Returns { status, side_effects: [...] }
}
```

All status transitions go through this function. The reducer is stateless (takes current + event, returns next + side effects); the coordinator interprets side effects (spawn worker, emit SSE, insert comment). This makes the state machine fully unit-testable.

Transition rules:
- `todo` + `run_requested` → `in_progress`, side effect: `spawn_executor`.
- `in_progress` + `run_completed` → `in_review`, side effect: `spawn_reviewer_if_assigned`.
- `in_progress` + `run_failed` → `in_progress` (unchanged), side effects: `post_error_comment`, `mark_badge_red`.
- `in_progress` + `human_move:in_review` → `in_review` (manual override for no-executor tasks).
- `in_review` + `review_approved` → `done`, side effect: `set_completed_at`.
- `in_review` + `review_rejected` → `in_progress`, side effects: `post_review_comment`, `clear_error_text`.
- `in_review` + `human_move:done` → `done`.
- `done` + `human_move:*` → allowed (drag back to any column).

### 5.11 Web UI

- Preact + Vite, hash routing (`#/tasks`), built via `npm run build` in the repo (UI deps live in `src/ui/package.json` and are installed alongside backend deps — no Docker needed; user's laptop has Node and vite).
- Served by Express from `src/ui/dist/` with a history-fallback to `index.html`.
- API client uses `fetch`; SSE via `EventSource`.
- `useSSE(runId)` hook in the task detail view maintains a local buffer of events, renders them grouped by turn (text, tool_use, tool_result), auto-scrolls to bottom until the user scrolls up.
- `useKanbanEvents()` hook subscribes to `/api/events/stream` and invalidates task query on `task_updated` events.
- Markdown editor: use `@uiw/react-md-editor` or similar; frontmatter edited via a form above the body.
- Design intent: clean, fast, monochrome with tasteful accent; icon set Lucide or Heroicons.

### 5.12 CLI

```bash
worklab start [--port 7878] [--foreground]
worklab stop
worklab status              # prints: pid, port, uptime, task counts, budget-today
worklab install-service     # writes launchd/systemd unit, enables auto-start
worklab uninstall-service
worklab backup              # tar data/ → ~/worklab-backups/YYYYMMDD-HHMMSS.tar.gz
worklab doctor              # checks: node version, db integrity (PRAGMA integrity_check), mcp.json validity, encryption key present, embedding model reachable
```

Implementation notes:
- `worklab start` runs the coordinator in foreground by default. `--foreground` is a no-op kept for explicitness.
- `worklab install-service` detects platform:
  - macOS → writes `~/Library/LaunchAgents/ai.worklab.plist` (KeepAlive, RunAtLoad) and `launchctl load -w` it.
  - Linux → writes `~/.config/systemd/user/worklab.service`, runs `systemctl --user daemon-reload && systemctl --user enable --now worklab`.
- `worklab stop` sends `SIGTERM` to the coordinator (PID file at `data/.coordinator.pid`).
- `worklab backup` first runs `PRAGMA wal_checkpoint(TRUNCATE);` then tars `data/` excluding `data/logs/` and the `-wal`/`-shm` files.

### 5.13 Configuration & environment

Env vars (all optional):

| Var | Default | Purpose |
|---|---|---|
| `WORKLAB_PORT` | `7878` | HTTP port |
| `WORKLAB_DATA_DIR` | `<repo>/data` | Data directory |
| `WORKLAB_WORKSPACE` | `~/worklab-workspace` | Default `cwd` for agent workers |
| `PROVIDER_ENCRYPTION_KEY` | (auto) | Override encryption key |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude SDK credentials |
| `OPENAI_API_KEY` | — | OpenAI SDK credentials |
| `WORKLAB_LOG_LEVEL` | `info` | pino level |
| `WORKLAB_TIMEZONE` | system | For cron |

Settings table (runtime-editable from UI):

| key | default | purpose |
|---|---|---|
| `consolidation_hour` | `3` | 0–23, local hour for nightly consolidation |
| `consolidation_enabled` | `true` |
| `default_embedding_model` | `"ollama:nomic-embed-text"` |
| `journal_tail_lines` | `80` |
| `kb_pinned_limit` | `10` |
| `worker_timeout_ms` | `1800000` | 30 min per worker run |
| `cancel_grace_ms` | `5000` |

---

## 6. API surface

All endpoints return JSON. Errors: `{ "error": { "code": "<slug>", "message": "..." } }` with an appropriate HTTP status.

### 6.1 Tasks

- `GET /api/tasks?status=<>&agent=<>` → `{ tasks: [...] }`
- `POST /api/tasks` → body `{ title, description?, instructions?, executor_agent?, reviewer_agent?, priority?, tags? }` → `{ task }`
- `GET /api/tasks/:id` → `{ task, comments, runs }`
- `PATCH /api/tasks/:id` → body: any subset of editable fields. Status changes via this route count as `human_move` events.
- `DELETE /api/tasks/:id`
- `POST /api/tasks/:id/run` → triggers `run_requested` event. 409 if already running.
- `POST /api/tasks/:id/cancel` → sends SIGTERM to active worker (if any). 404 if no active run.
- `POST /api/tasks/:id/retry` → same as `run` but records `retry_count++`.
- `POST /api/tasks/:id/comments` → body `{ body }` → creates a human comment.

### 6.2 Task runs & agent logs

- `GET /api/tasks/:id/runs` → `{ runs: [...] }`
- `GET /api/runs/:id` → `{ run, log }`
- `GET /api/runs/:id/events` → full events array (for already-completed runs).
- `GET /api/runs/:id/stream` → SSE stream of events (live runs).

SSE event types:
```json
{"type":"started","runId":"...","taskId":"...","ts":17XXX}
{"type":"sdk_event","event":{ /* raw SDK event */ }}
{"type":"journal","bullet":"..."}
{"type":"final","text":"...","usage":{ /* ... */ }}
{"type":"error","message":"..."}
{"type":"cancelled"}
{"type":"done","exitCode":0}
```

### 6.3 Agents, skills, KB, providers, MCP, settings, activity

All follow `GET/POST/GET/:id/PATCH/:id/DELETE/:id` REST conventions as enumerated in §5 / design section 5. Full route list in `src/api/routes-*.js`.

### 6.4 Global event stream

- `GET /api/events/stream` → SSE feed of coordinator-wide events: `task_updated`, `task_created`, `task_deleted`, `run_started`, `run_ended`, `agent_updated`, etc.

---

## 7. Observability, error handling, testing

### 7.1 Logging

- `pino` JSON logs to `data/logs/coordinator.log` (rotate daily, keep 14) and `data/logs/workers/<run-id>.log`.
- Console mirror when coordinator runs with TTY stdout.
- Sensitive value redaction: reuse Mickey's pattern — regex-strip `sk-…`, bearer tokens, email addresses, hex-32+ strings from logged strings before write.

### 7.2 Error surfaces

| Failure | Observable surface |
|---|---|
| Worker SDK timeout | `task_runs.status=error`, error comment on task, red badge, `error` SSE event |
| MCP subprocess crash | Worker catches stderr from SDK, emits `error` event, exits nonzero |
| Coordinator DB locked | Logged at `warn`, request retried once, else 503 |
| Invalid model string | Rejected at API layer with `400 invalid_model` |
| Port in use | Coordinator exits nonzero with clear message |
| Missing encryption key file | Auto-generated on first boot, logged at `info` with fingerprint |

No automatic retries for failed runs in v1 (silent retry loops burn tokens).

### 7.3 Testing

- **Framework:** Vitest, ESM.
- **Layers:**
  1. **Unit** (`src/__tests__/core/`): `state-machine` (full transition matrix), `crypto` (encrypt/decrypt round-trip, key resolution), `skills.parseSkillFrontmatter`, `mcp-config.loadMcpConfig`, `ai.resolveModel`, `providers.isPrivateBaseUrl`.
  2. **Integration** (`src/__tests__/api/`): coordinator + DB + `helpers/fake-worker.js` (a scripted worker binary that emits predetermined events). Covers full task lifecycle, cancellation, review flow, consolidation.
  3. **E2E smoke** (`src/__tests__/e2e/`): spawn coordinator on random port, drive via headless browser (Playwright) — create task, run with a stub agent (pointing to fake worker), observe kanban transitions.
- **Coverage target (v1):** 60% line coverage on `src/core/`, 100% state-machine transition coverage, happy-path integration for each API route group.
- **Reproducibility test:** wipe DB, restart coordinator, re-run embedding generator, confirm `embeddings` table is rebuilt from filesystem.

---

## 8. Phased execution plan

Each phase is a shippable milestone. An AI executing this PRD should complete one phase fully (including tests and verification) before moving to the next. Phase N depends on phase N−1; inside a phase, tasks can parallelize.

### Phase 1 — Skeleton, DB, CLI, tasks-only MVP

**Goal:** You can `worklab start`, open `http://localhost:7878/#/tasks`, create/edit/delete tasks on a kanban board, drag between columns. No agent execution yet.

**Deliverables:**
- Repo scaffold (`package.json`, `vitest.config.js`, `.gitignore`, `data-template/`, `src/` skeleton).
- `src/core/db.js` with the full schema in §4.1 and migration runner.
- `src/core/logger.js` (pino).
- `src/core/config.js` (env + defaults).
- `src/coordinator.js` + `src/api/server.js` + `src/api/sse.js` (broker) + `src/api/routes-tasks.js` + `src/api/routes-settings.js` + `src/api/routes-activity.js`.
- `src/core/state-machine.js` (pure reducer, full unit tests).
- `src/ui/` Preact+Vite app with `Kanban.jsx`, `TaskDetail.jsx` (comments + manual state control only, no run UI yet), `Settings.jsx`.
- `src/cli/` with `start`, `stop`, `status`, `doctor`.
- `.gitignore` excludes `data/` but keeps `data-template/`.
- First-boot logic: seed `data-template/` → `data/` if `data/` missing.

**Acceptance criteria:**
- `worklab start` boots a coordinator, UI loads, tasks CRUD works end-to-end.
- State-machine reducer unit tests cover every transition in §5.10.
- `worklab doctor` reports OK.
- Kanban drag-and-drop emits `human_move` events; `task_updated` SSE keeps two open tabs in sync.

**Out of scope:** agents, workers, running tasks, skills, KB, providers, MCP.

### Phase 2 — Claude agent runtime, skills, MCP, journaling

**Goal:** You can create a Claude-SDK agent, attach it as executor to a task, hit "Run now", and watch it execute live. Journal entries appear in `data/agents/<name>/JOURNAL.md`.

**Deliverables:**
- `src/core/ai.js` + `src/core/ai-claude.js` (resolveModel, generateResponse, dispatch).
- `src/core/skills.js` (frontmatter parser + loader).
- `src/core/mcp-config.js` (loader + builtin injection).
- `src/mcp/worklab-tools.js` with `journal_append`, `journal_summary`, `memory_read` (kb/embedding tools come in Phase 3/5).
- `src/mcp/launch-worklab-mcp.sh`.
- `src/core/context.js` (system prompt assembler — execute mode only).
- `src/core/journal.js` (atomic append, parse).
- `src/worker.js` (execute mode).
- `src/coordinator/spawn-worker.js` (spawn + event demux + exit handling + worker_pid tracking).
- `src/coordinator/task-watcher.js` (reacts to state changes from routes-tasks).
- `src/api/routes-agents.js`, `routes-skills.js`, `routes-mcp.js`.
- UI: `Agents.jsx`, `AgentEdit.jsx`, `Skills.jsx`, `SkillEdit.jsx` (markdown editor), task detail extended with run button + live event timeline (SSE).
- Seed `data-template/skills/example/SKILL.md`.

**Acceptance criteria:**
- Create a Claude agent with a trivial instruction ("reply with the current time and journal what you did").
- Create a task assigning that agent as executor, click Run now.
- Task flips to `in_progress`, events stream live in the detail view.
- Task flips to `in_review` on clean exit.
- `data/agents/<name>/JOURNAL.md` has a new dated bullet entry.
- `agent_logs` row captured with full event array.
- SIGTERM cancellation works (kill from CLI and from UI cancel button).
- Integration test: fake-worker scripted run exercising all SSE event types.

**Out of scope:** reviewer flow (coordinator leaves tasks parked in `in_review` if no reviewer), KB, multi-SDK, consolidation, embeddings.

### Phase 3 — Review flow, KB

**Goal:** Tasks with a reviewer agent auto-review; approvals flow to `done`, rejections flow back to `in_progress`. Humans and agents can manage a knowledge base.

**Deliverables:**
- Worker `--mode review` + review-mode prompt template in `context.js`.
- Verdict parser: first line of reviewer's final text must match `/^VERDICT:\s*(APPROVE|REJECT)\b/`.
- Coordinator: on review worker exit, parse verdict, fire `review_approved` or `review_rejected`.
- Reviewer comment posted with verdict summary + full reviewer output body.
- MCP tools: `kb_create`, `kb_update`, `kb_delete`, `kb_read`, `kb_list`. (Search deferred to Phase 5.)
- `src/core/kb.js` (frontmatter-aware CRUD, `writeAtomic`).
- `src/api/routes-kb.js`.
- UI: `Knowledge.jsx`, `KbEdit.jsx`. Pinned entries surfaced at top.
- Context assembler: include pinned KB entries in system prompts.
- Task detail UI: visual distinction for `system`/`agent`/`human` comments; review verdict badge.

**Acceptance criteria:**
- End-to-end task with both executor and reviewer runs both workers automatically; task lands in `done` (approve path) or loops back to `in_progress` (reject path with notes).
- An agent can `kb_create` during a run; the entry appears in the KB list.
- Pinned KB entries visible in agent system prompts (verified via event log — first system-message assertion in test).

**Out of scope:** multi-SDK, providers, consolidation, semantic search.

### Phase 4 — Multi-SDK, custom providers, encryption

**Goal:** You can add an Ollama or OpenAI provider, assign an agent to use a custom model, and run a task through it.

**Deliverables:**
- `src/core/crypto.js` (AES-256-GCM + HKDF master key, auto-generate `.provider-encryption-key`).
- `src/core/providers.js` (URL allowlist, discovery for `/v1/models` and `/api/tags`, decryption scoped to worker).
- `src/core/ai-openai.js` + `src/core/ai-vercel.js` (Vercel path covers Ollama + OpenAI-compat + tools + MCP via `@modelcontextprotocol/sdk`).
- `src/api/routes-providers.js`.
- UI: `Providers.jsx` (provider CRUD, discovery button, model enable toggle). `AgentEdit.jsx` extended with full model picker that includes custom models under "Custom providers" section, labeled with real names (not "Fast/Good/Best").
- Cost + usage display populated for all three SDKs in the agent log UI.
- Migrate `resolveModel` to parse `vercel:<providerId>:<modelName>` and `openai:<model>` forms.

**Acceptance criteria:**
- Register an Ollama provider pointing at `http://localhost:11434`, hit discover, see models listed.
- Enable `gemma3:4b` (or whatever), assign to a test agent, run a task. Works end-to-end.
- Encryption key auto-generated on first run with `0600` perms. Deleting the key file + restart regenerates (but old API keys become unreadable — documented behavior).
- Unit test: encrypt→decrypt round-trip with master key rotation scenario.

**Out of scope:** consolidation, embeddings, service install.

### Phase 5 — Consolidation, semantic search, service install, backup, activity & settings polish

**Goal:** Tool is daily-driver complete. Nightly memory consolidation runs automatically, KB and journals are semantically searchable, the tool can install itself as a background service, and you can back up your data.

**Deliverables:**
- Worker `--mode consolidate` + consolidate-mode prompt template.
- `src/coordinator/consolidation-cron.js` (runs on `settings.consolidation_hour`, skips agents with no new journal entries, emits standard `task_runs` rows with `mode=consolidate` so UI surfaces them in activity).
- UI: "Consolidate now" button on agent edit page, triggers `POST /api/agents/:name/consolidate`.
- `src/core/embeddings.js`:
  - Default backend: Ollama `nomic-embed-text`. Configurable via `settings.default_embedding_model`.
  - Filesystem watcher (`chokidar`) on `data/knowledge/`, `data/agents/*/JOURNAL.md`, `data/agents/*/MEMORY.md` → debounced re-embed.
  - Hybrid search: FTS5 (SQLite native) + cosine on vectors; simple score blend.
- Extend `worklab-tools.js` with `kb_search` (now functional), `journal_search(agent?, query, limit)`, `memory_search(agent?, query, limit)`.
- `src/cli/install-service.js`, `uninstall-service.js`, `backup.js`.
- `scripts/generate-launchd-plist.js` and systemd-unit template.
- UI: `Activity.jsx` (paginated feed), `Settings.jsx` (consolidation hour, embedding model, journal-tail lines, pinned limit, worker timeout, cancel grace).
- Rebuild-indexes test: delete `embeddings` table, restart, confirm population completes within N seconds for the seeded data.

**Acceptance criteria:**
- Nightly cron fires at configured hour, produces a `consolidate` task run per agent with new journal entries, writes a new `MEMORY.md`.
- "Consolidate now" button works on-demand.
- `kb_search` returns relevant entries for a query that matches a pinned entry's body.
- `worklab install-service` on macOS creates and loads a LaunchAgent; coordinator survives reboot and `open http://localhost:7878/#/tasks` works.
- Same on Linux via systemd user unit.
- `worklab backup` produces a valid tarball; restoring (`tar -xzf … && worklab start`) resumes the board intact.

**Out of scope (deferred to v2):** scheduled/recurring tasks, cost budgets, desktop shell, workflow chains, cloud backup, skill lab, Windows support.

---

## 9. YOLO mode (host access) — explicit confirmation

Per the owner's explicit requirement: workers run with **unrestricted host access**.

- `permissionMode: "bypassPermissions"` on every worker SDK call.
- `disallowedTools: []`.
- `allowedTools` = full built-in set: `Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch` (plus MCP tools from the agent's allowlist).
- Default `cwd` for workers: `~/worklab-workspace/` (auto-created on first coordinator boot). Agents can `cd` or reference absolute paths anywhere on the host; no sandbox.
- No confirmation prompts, no tool approval UI.

Implications the owner has accepted:
- Any agent with `Bash` in its allowlist can `rm -rf`, `curl | sh`, or exfiltrate anything the user has access to.
- No network restrictions beyond what the OS enforces.
- A malicious or confused agent can irreversibly damage the user's files.
- Mitigation is trust + the per-agent tool/MCP allowlists + the append-only activity feed + manual backups.

This is a local, single-user, self-hosted tool. The owner is the sole operator and accepts these consequences.

---

## 10. Glossary

- **Agent** — a configured personality-less worker identity with SDK, model, effort, instructions, skill allowlist, MCP allowlist, built-in tool allowlist.
- **Skill** — a folder under `data/skills/<name>/` containing `SKILL.md` (playbook) plus optional assets. Prose, not code.
- **Task** — a kanban card with title, description, instructions, status, executor_agent, reviewer_agent.
- **Task run** — one invocation of a worker for a task. Modes: execute, review, consolidate.
- **Journal** — append-only `JOURNAL.md` per agent, written via `journal_append` MCP tool during runs.
- **Memory** — consolidated `MEMORY.md` per agent, rewritten nightly or on demand.
- **Knowledge base (KB)** — shared `data/knowledge/<slug>.md` files, written by humans and agents.
- **Coordinator** — long-lived Node process serving UI + API + watching state.
- **Worker** — short-lived Node subprocess executing one run.
- **YOLO** — `permissionMode: bypassPermissions`, unrestricted host access, no prompts.
- **SSE** — server-sent events; used for live run streams and kanban updates.

---

## 11. Open questions (for future phases, not blocking v1)

- Should journal entries for a task also be rendered inline in the task detail view (currently only lives in the filesystem)? — Likely yes in v1.1.
- Vector quantization for embeddings to shrink SQLite size? Not needed until ~10k chunks.
- Should `kb_search` results bubble up through the system prompt as context for subsequent turns, or only appear as tool output? — v1: tool output only.
- Cost display — per-run only, or rolling daily/weekly aggregates on the dashboard? — v1: per-run only; v2: add activity-page aggregates.
- Skill inheritance (skills that extend other skills)? — Out of scope indefinitely.
