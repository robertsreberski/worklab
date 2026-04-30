# `src/integrations/` — External Integrations

Adapters between Worklab and external services (currently only Slack). Each
integration is a self-contained subdirectory; integrations talk to Worklab via
`src/core/` (data) and `src/agent/` (runtime), never via the HTTP API.

## May import from

- `src/core/`, `src/agent/`, `src/ai/`

## Must NOT import from

- `better-sqlite3`
- `src/api/` (no calling our own HTTP)
- `src/cli/`, `src/coordinator/`, `src/worker/`, `src/mcp/`

## Current shape

```
src/integrations/
└── slack/
    ├── service.js
    ├── context.js
    ├── filter.js
    └── triage-result.js
```
