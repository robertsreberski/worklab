# `src/api/` — HTTP Edge

Express routes and SSE streaming. Every handler routes through `src/core/`
helpers; direct DB access from this layer is forbidden by the boundary lint.

## May import from

- `src/core/`, `src/agent/`, `src/ai/`
- `express`, `cors`, `pino`, etc.

## Must NOT import from

- `better-sqlite3`
- `src/coordinator/`, `src/mcp/`, `src/integrations/`, `src/cli/`,
  `src/worker/`

## Future shape

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

The current `routes-*.js` files lose their `routes-` prefix in Phase 7 and
move under `routes/`.
