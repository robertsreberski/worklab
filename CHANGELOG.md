# Changelog

All notable changes to Worklab are tagged `phase-N` on the `main` branch.

The project is versioned by phase, not SemVer. Each phase tag points to a
shippable milestone that fully implements a slice of the [product spec](docs/spec/worklab-design.md) §8.

## [Unreleased]

- Pre-launch polish: deeper provider API tests, multi-SDK dispatch smoke
  coverage, dropped unused `ollama-ai-provider-v2` dep.
- In-repo documentation: PRD, Phase 1–5 plans (reconstructed where absent),
  Phase 6+ roadmap, architecture overview, getting-started / configuration /
  CLI / troubleshooting guides, MIT LICENSE, CHANGELOG, CONTRIBUTING.

## [phase-5] - 2026-04-22 (`e899cda`)

- Worker `--mode consolidate` + nightly `consolidation-cron` rewrites each
  agent's `MEMORY.md` from its `JOURNAL.md`.
- `POST /api/agents/:name/consolidate` + "Consolidate now" button on
  AgentEdit.
- Hybrid FTS5 + vector embeddings (`src/core/embeddings.js`), default
  `ollama:nomic-embed-text`, FS watcher via chokidar (`src/coordinator/search-indexer.js`).
- MCP tools: `kb_search`, `journal_search`, `memory_search`.
- REST: `GET /api/search`, `GET /api/search/status`.
- CLI: `worklab install-service` (launchd/systemd), `uninstall-service`,
  `backup` (tar.gz of `data/`).
- UI: Activity page (paginated feed), Settings page polish
  (consolidation hour, embedding model, journal tail lines, pinned limit,
  worker timeout, cancel grace).
- Schema v3: nullable `task_runs.task_id` for consolidate runs, new
  `embeddings` + FTS table, `agent_consolidations` table.

SHA range: `2dc839f..f87b620`.

## [phase-4] - 2026-04-22 (`76e354b`)

- AES-256-GCM encryption with HKDF master key (`src/core/crypto.js`),
  auto-generated `data/.provider-encryption-key` at `0600`.
- Custom provider registry (`src/core/providers.js`) with CIDR URL
  allowlist (RFC1918 / 100.64/10 / localhost / IPv6 private; public URLs
  require `trust_public_url: true` AND HTTPS).
- Model discovery (`/v1/models` for OpenAI-compat, `/api/tags` for Ollama).
- Multi-SDK dispatch (`src/core/ai.js` → `ai-openai.js` / `ai-vercel.js`):
  `resolveModel` parses `openai:<model>` and `vercel:<providerId>:<modelName>`.
- Tool parity across SDKs via `ai-tool-helpers.js`.
- Cost estimation (`src/core/cost.js`) wired into EventTimeline.
- UI: Providers page, grouped model picker in AgentEdit, cost + token
  display on final events.

SHA range: `8b01ef6..d9e8568`.

## [phase-3] - 2026-04-22 (`277d641`)

- Reviewer loop: task-watcher spawns review-mode workers on executor
  completion; `parseVerdict` (`src/core/review.js`) extracts
  `VERDICT: APPROVE|REJECT`; state machine routes to `done` or
  `in_progress` with cleared `error_text`.
- `run_failed` alignment (spec §5.10): executor failure now routes
  through the reducer (removed the `todo` bypass).
- Knowledge base CRUD: `src/core/kb.js` atomic writes + fsync, REST
  routes (`/api/kb`), 5 MCP tools (`kb_create/update/delete/read/list`),
  UI at `#/knowledge`.
- Pinned KB entries injected into agent system prompts
  (`kbListPinned`, capped by `settings.kb_pinned_limit` = 10).
- Comment UI: `CommentAuthor` chip (human/agent/system) + verdict
  badges + red error dot on kanban cards with `error_text`.
- Seed `data-template/knowledge/welcome.md`.

SHA range: `ab0fd65..cfc005d`.

## [phase-2] - 2026-04-22 (`9753a64`)

- Claude Agent SDK integration (`src/core/ai.js` + `ai-claude.js`).
- Skills loader (YAML frontmatter, `priority: always` inlined).
- Built-in `worklab` MCP stdio server (`journal_append`,
  `journal_summary`, `memory_read`).
- Worker execute-mode binary (`src/worker.js`) with SDK + MCP + journal.
- Coordinator spawn-worker + task-watcher.
- REST: agents CRUD, skills CRUD, MCP config GET/PUT.
- UI: Agents + Skills routes, Run-now button, live event timeline.

## [phase-1] - 2026-04-22 (`2ad429a`)

- Coordinator + Express + SSE broker (`localhost:7878`).
- SQLite schema v1 (`tasks`, `task_comments`, `task_runs`, `agents`,
  `agent_logs`, `custom_providers`, `custom_models`, `embeddings`,
  `settings`).
- Pure-reducer state machine (`src/core/state-machine.js`).
- Preact + Vite UI: Kanban, TaskDetail, Settings, hash routing,
  SSE-driven live updates.
- CLI: `worklab start`, `stop`, `status`, `doctor`.
- First-boot seeds `data/` from `data-template/`.
