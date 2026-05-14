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

## Public Domain Barrels

```
src/core/
├── index.js            # compatibility barrel for existing callers
├── db/index.js         # open, schema, migrations (DAL entrypoint)
├── workflow/index.js   # task state machine, transitions, joins, attachments
├── runtime/index.js    # model dispatch, run input, logs, artifacts, evidence
├── content/index.js    # KB, mentions, journals, memory, embeddings, skills
└── platform/index.js   # config, settings, credentials, MCP, teams, projects
```

Prefer the narrowest public domain barrel for new edge-layer imports. Keep
implementation files private unless a caller is in a documented coordinator
carve-out or uses `src/core/db/queries/*`.
