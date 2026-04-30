# `src/cli/` — `worklab` Binary

Subcommands for the `worklab` CLI (`bin` in `package.json`). `index.js`
lazy-imports each subcommand. `args.js` parses cross-command flags
(`--port`, `--host`, `--data-dir`, `--workspace`) and applies them to
`process.env` before `bootstrapWorklabEnv` runs.

## May import from

- `src/core/`, `src/coordinator/`, `src/agent/`, `src/ai/`

## Must NOT import from

- `src/api/`, `src/integrations/`, `src/mcp/`

## Subcommands

```
src/cli/
├── index.js              # dispatcher (lazy-import)
├── args.js               # cross-command flag parsing
├── start.js / stop.js / restart.js / status.js / serve.js
├── doctor.js             # environment diagnostics
├── backup.js
├── mcp.js                # stdio MCP bridge for agents
└── install-service.js / uninstall-service.js
```

Subcommands that need the DB go through `src/core/db/queries/*` after the
DAL extraction (Phase 2). Today some still call `db.prepare()` directly.
