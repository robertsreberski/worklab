# `src/core/` — Worklab Domain

Business logic and persistence for tasks, runs, agents, KB, journals, memory,
skills, automations, projects, settings, embeddings, and provider configuration.
The DB lives here and only here; everything outside `src/core/db/**` must go
through this layer to read or write SQLite.

## May import from

- `src/agent/` (agent kernel)
- `src/ai/` (provider layer)
- Third-party packages

## Must NOT import from

- `src/coordinator/`, `src/worker/`, `src/api/`, `src/mcp/`,
  `src/integrations/`, `src/cli/`
- `better-sqlite3` outside `src/core/db/**`

## Future shape (target of the modularization)

```
src/core/
├── db/                 # open, schema, migrations, queries (DAL)
├── workflow/           # task state machine + transitions
├── runs/               # run input building, artifacts, logs, events
├── kb/                 # knowledge base storage + publisher
├── memory/             # journal, memory, consolidation helpers
├── skills/             # skill catalog + loader
├── automations/        # trigger definitions + audit records
├── search/             # embeddings + FTS
├── providers/          # custom OpenAI-compat provider rows
└── …                   # leaf utilities (ids, slugs, env, config, cost, etc.)
```
