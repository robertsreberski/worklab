# Worklab

Worklab is a local, single-user AI agent orchestration workspace with a web UI,
host service controls, and a built-in admin MCP server.

The task and agent workflow is being redesigned around a code-derived audit:

- [Task and agent logic audit](docs/audits/task-agent-logic-audit.md)

Older architecture, PRD, phase-plan, and setup docs were removed because the
code has moved faster than those documents and they were no longer reliable.
Use the source and tests as the operational truth until new implementation
docs are generated from the v2 workflow.

## Development

```bash
npm install
npm test
```

Build the UI and run Worklab in the foreground:

```bash
npm start
```

Open `http://127.0.0.1:7878`.

For UI hot reload, run the API/static server and Vite dev server separately:

```bash
npm run dev:api
npm run dev:ui
```

Open the Vite URL, normally `http://127.0.0.1:5173`. `worklab serve` and
`npm run dev:api` do not hot reload UI code; they serve the built bundle from
`src/ui/dist`. The Vite server hot reloads `src/ui` changes and proxies `/api`
to the Worklab API.

## Configuration

Runtime data defaults to `~/.worklab`. Worklab loads `~/.worklab/.env` on
startup, while shell environment variables and CLI flags take precedence.

Common settings:

```bash
WORKLAB_PORT=7878
WORKLAB_HOST=127.0.0.1
WORKLAB_DATA_DIR=/home/me/.worklab
WORKLAB_WORKSPACE=/home/me/worklab-workspace
WORKLAB_LOG_LEVEL=info
```

The port and host can also be set per command:

```bash
worklab serve --port 9000
worklab start --port 9000 --host 0.0.0.0
worklab restart --port 9000
worklab status --port 9000
```

When using Vite hot reload with a non-default API port, pass the same port to
both processes:

```bash
npm run dev:api -- --port 9000
WORKLAB_PORT=9000 npm run dev:ui
```

`worklab start` and `worklab restart` regenerate the host service definition
with the effective host, port, data directory, workspace, and log level.

## CLI Service

Install the local `worklab` command from this checkout:

```bash
npm run install:worklab
```

Then manage the per-user service:

```bash
worklab start
worklab restart
worklab status
worklab stop
```

`start` and `restart` rebuild the UI before starting the service. Use
`--no-build` only when you intentionally want to keep the existing built UI.

Worklab exposes a token-protected local admin MCP endpoint with full Worklab API
access. Agents that need stdio MCP can run:

```bash
worklab mcp
```

## Testing

Run the full unit and integration suite:

```bash
npm test
```

Build the UI before validating service/static serving behavior:

```bash
npm run build:ui
```

Browser regressions use Playwright and should run against a freshly built UI:

```bash
npm run test:e2e:ollama
```

See [AGENTS.md](AGENTS.md) for future agent development and testing guidance.

## License

MIT. See [LICENSE](LICENSE).
