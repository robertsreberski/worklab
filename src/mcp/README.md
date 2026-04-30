# `src/mcp/` — MCP Servers

Two MCP transports:

- **Admin server** (`admin/`) — HTTP, bearer-token, full Worklab surface area.
  Used by trusted automation and developer tools.
- **Agent server** (`agent/`) — stdio, narrow tool surface (journal, memory,
  KB writes, child-task introspection). Spawned per-agent by the worker.

Tool definitions are split per domain under each server's `tools/`
directory (e.g. `admin/tools/projects.js`, `agent/tools/kb.js`). Shared
JSON-Schema builders, compact-output helpers, and the HTTP `apiRequest`
plumbing live in `mcp/shared/`. The thin `admin/tools.js` and
`agent/tools.js` files re-export the public surface so existing callers
(`cli/mcp.js`, `worker.js`, `api/routes/tasks.js`) keep their import
paths.

## May import from

- `src/core/`, `src/agent/`, `src/ai/`

## Must NOT import from

- `better-sqlite3`
- `src/api/`, `src/integrations/`, `src/cli/`, `src/coordinator/`,
  `src/worker/`

## Layout

```
src/mcp/
├── shared/
│   ├── schema-helpers.js   # string/number/object/... + compact* + encodePath
│   └── tool-registry.js    # apiRequest + spec-tuple handler builder
├── admin/
│   ├── server.js
│   ├── tools.js            # re-export shim
│   └── tools/
│       ├── index.js        # aggregates definitions + handlers
│       ├── service.js      # status / service control
│       ├── projects.js
│       ├── tasks.js
│       ├── agents.js
│       ├── runs.js
│       ├── kb.js           # KB CRUD + worklab_search
│       ├── skills.js
│       ├── automations.js
│       ├── providers.js
│       ├── models.js
│       ├── settings.js     # settings + external MCP config + status
│       └── api-escape.js   # worklab_api_request
└── agent/
    ├── server.js
    ├── tools.js            # re-export shim
    └── tools/
        ├── index.js        # aggregates definitions + handlers
        ├── shared.js       # withDb / safeParse
        ├── memory.js       # journal_*, memory_read, run_log_read, *_search
        ├── tasks.js        # list_children, get_child_result
        ├── agents.js       # agent_create
        └── kb.js           # kb_create/update/delete/read/list/search
```
