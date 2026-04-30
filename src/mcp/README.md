# `src/mcp/` — MCP Servers

Two MCP transports:

- **Admin server** (`admin/`) — HTTP, bearer-token, full Worklab surface area.
  Used by trusted automation and developer tools.
- **Agent server** (`agent/`) — stdio, narrow tool surface (journal, memory,
  KB writes, child-task introspection). Spawned per-agent by the worker.

Tool definitions live one-per-file under each server; shared schemas come
from `mcp/shared/tool-registry.js`.

## May import from

- `src/core/`, `src/agent/`, `src/ai/`

## Must NOT import from

- `better-sqlite3`
- `src/api/`, `src/integrations/`, `src/cli/`, `src/coordinator/`,
  `src/worker/`

## Future shape

```
src/mcp/
├── shared/
│   ├── tool-registry.js
│   └── dispatch.js
├── admin/
│   ├── server.js
│   └── tools/<one file per tool>.js
└── agent/
    ├── server.js
    └── tools/<one file per tool>.js
```
