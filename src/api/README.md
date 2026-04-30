# `src/api/` — HTTP Edge

Express routes and SSE streaming. Route handlers use `src/core/` domain
helpers or `src/core/db/queries/*` DAL helpers; direct `db.prepare()` from
this layer is forbidden by boundary lint.

## May import from

- `src/core/`, `src/agent/`, `src/ai/`
- `express`, `cors`, `pino`, etc.

## Must NOT import from

- `better-sqlite3`
- `src/coordinator/`, `src/mcp/`, `src/integrations/`, `src/cli/`,
  `src/worker/`

## Layout

```
src/api/
├── server.js
├── sse.js
└── routes/
    ├── tasks.js
    ├── agents.js
    ├── projects.js
    ├── automations.js
    ├── runs.js
    ├── kb.js
    ├── skills.js
    ├── settings.js
    ├── providers.js
    ├── models.js
    ├── activity.js
    ├── search.js
    ├── assistant.js
    ├── mcp.js
    └── slack.js
```
