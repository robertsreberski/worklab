# Worklab

Local, single-user AI agent orchestration tool for work. Linear-style task queue, configurable agents backed by Claude / OpenAI / Ollama / any OpenAI-compat endpoint, automatic reviewer loop, shared filesystem knowledge base, nightly memory consolidation, and hybrid semantic + FTS search — all running on localhost, no auth, no cloud.

> Single-user, localhost-only by design. Expose it to the network at your own risk (Tailscale, reverse proxy + auth, etc.) — there is no built-in authentication.

## Features

- **Kanban task board** — `todo` → `in_progress` → `in_review` → `done`, drag-and-drop.
- **Configurable agents** — per-agent SDK (Claude / OpenAI / Vercel), model, effort, instructions, skill allowlist, MCP allowlist, built-in tool allowlist.
- **Reviewer loop** — assign an executor AND a reviewer; reviewer auto-runs on executor exit, parses `VERDICT: APPROVE|REJECT`, flips to `done` or back to `in_progress` with notes.
- **Knowledge base** — shared `data/knowledge/<slug>.md` with YAML frontmatter, human + agent CRUD via UI and MCP tools; pinned entries inlined in every agent's system prompt.
- **Multi-SDK** — `claude:<tier>`, `openai:<model>`, or `vercel:<providerId>:<modelName>` strings dispatch to the right path at runtime. Custom providers (Ollama, OpenAI-compat) registered via the UI, API keys encrypted at rest with AES-256-GCM.
- **Nightly consolidation** — each agent's bullet journal rewritten into a structured `MEMORY.md` (Procedures / Facts / Gotchas).
- **Hybrid search** — `kb_search`, `journal_search`, `memory_search` MCP tools backed by SQLite FTS5 + vector embeddings (default `ollama:nomic-embed-text`, configurable).
- **Live streaming** — SSE per-run event stream renders thinking, tool calls, and outputs in the task detail view.
- **Service install** — `worklab install-service` writes a launchd plist on macOS or a systemd user unit on Linux.
- **Backup** — `worklab backup` produces a portable tarball of `data/`.

## Documentation

Everything below lives in this repo under `docs/`:

- [Architecture overview](docs/architecture.md) — process topology, data flows, storage model, security model.
- [Getting started](docs/getting-started.md) — install, first agent, first task, first KB entry.
- [Configuration](docs/configuration.md) — env vars, settings keys, data layout, MCP config.
- [CLI reference](docs/cli.md) — every `worklab <subcommand>`.
- [Troubleshooting](docs/troubleshooting.md) — common issues and fixes.
- **Canonical product spec (PRD):** [`docs/spec/worklab-design.md`](docs/spec/worklab-design.md)
- **Phase plans** (development history):
  - [Phase 1](docs/plans/phase-1.md) — skeleton + DB + CLI + tasks-only MVP (tag `phase-1`)
  - [Phase 2](docs/plans/phase-2.md) — Claude runtime + skills + MCP + journaling (tag `phase-2`)
  - [Phase 3](docs/plans/phase-3.md) — reviewer loop + KB + pinned KB in prompts + comment UI (tag `phase-3`)
  - [Phase 4](docs/plans/phase-4.md) — multi-SDK + custom providers + crypto + cost display (tag `phase-4`)
  - [Phase 5](docs/plans/phase-5.md) — consolidation + semantic search + service install + backup + activity/settings polish (tag `phase-5`)
- [Phase 6+ roadmap](docs/plans/phase-6-roadmap.md) — near-term, mid-term, explicit non-goals.

Original workspace-external copies of the PRD + Phase 1–2 plans live at `/opt/claude-workspace/docs/superpowers/` (for historical traceability only — the in-repo copies are canonical).

## Quick start

```bash
npm install
export ANTHROPIC_API_KEY=sk-...   # or CLAUDE_CODE_OAUTH_TOKEN, or OPENAI_API_KEY, or point at local Ollama
npm start
```

Open http://localhost:7878.

Then follow [Getting started](docs/getting-started.md) to create your first agent and task.

## Screenshots

_Screenshots TBD._

## License

MIT — see [LICENSE](LICENSE).
