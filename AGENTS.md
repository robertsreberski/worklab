# AGENTS.md

These instructions apply to the whole repository.

## Project Shape

Worklab is a Node 22.19+ local agent orchestration app. Runtime code is split by
boundary:

- `src/core`: configuration, persistence helpers, providers, credentials, task
  state, knowledge, and shared domain logic.
- `src/api`: Express HTTP routes and SSE.
- `src/coordinator`: scheduling, worker spawning, indexing, and long-running
  orchestration.
- `src/mcp`: user MCP config plus the built-in full-access admin MCP tools.
- `src/cli`: `worklab` command, service install/start/restart/stop/status,
  backup, doctor, and stdio MCP bridge.
- `src/ui`: Preact/Vite UI.

Do not reintroduce behavior from deleted historical planning docs. The source,
tests, `README.md`, `CONTRIBUTING.md`, and `docs/audits/task-agent-logic-audit.md`
are the current references.

## Development Commands

Install dependencies:

```bash
npm install
```

Run the full Vitest suite:

```bash
npm test
```

Run focused tests while iterating:

```bash
npx vitest run src/__tests__/cli/args.test.js
npx vitest run src/__tests__/core/config.test.js
npx vitest run src/__tests__/mcp/admin-tools.test.js
```

Build the UI:

```bash
npm run build:ui
```

Run the foreground API/static server:

```bash
npm run dev:api
```

Run the Vite UI with hot reload in a second terminal:

```bash
npm run dev:ui
```

`worklab serve`, `npm start`, and `npm run dev:api` serve the built UI from
`src/ui/dist`; they do not hot reload UI source. Use `npm run dev:ui` for HMR.

## Configuration And Services

Default runtime data lives in `~/.worklab`. Worklab loads `.env` from the active
data directory, but shell env and CLI flags take precedence.

Common overrides:

```bash
WORKLAB_PORT=9000
WORKLAB_HOST=127.0.0.1
WORKLAB_DATA_DIR=/tmp/worklab-dev
WORKLAB_WORKSPACE=/tmp/worklab-workspace
```

CLI config flags are passed after the command:

```bash
worklab serve --port 9000 --data-dir /tmp/worklab-dev
worklab start --port 9000
worklab restart --port 9000
```

`worklab start` and `worklab restart` rebuild `src/ui/dist`, write the user
service definition, and start or restart the service. The generated service
captures the effective host, port, data directory, workspace, and log level.

For tailnet access, keep Worklab bound to localhost and use Tailscale Serve:

```bash
tailscale serve --bg --yes --http 7878 7878
tailscale serve status
```

Verify the MagicDNS URL from `tailscale serve status`; raw Tailscale IP requests
can return a Tailscale Serve 404 because Serve routes by hostname.

## Testing Rules

Keep tests isolated from a developer's real `~/.worklab`. Use temporary
directories and set `WORKLAB_DATA_DIR` explicitly in tests that touch runtime
files, service tokens, databases, logs, MCP config, or backups.

Prefer targeted unit tests for local behavior and add broader tests when the
change crosses module boundaries:

- `src/__tests__/core` for config, env, state, providers, DB, credentials, and
  domain helpers.
- `src/__tests__/api` with `supertest` for route behavior.
- `src/__tests__/mcp` for MCP tool schemas and handler mappings.
- `src/__tests__/cli` for command parsing, service rendering, backup, and
  process-management behavior.
- `src/__tests__/ui` for pure UI formatting/components.
- `src/__tests__/playwright` for browser regressions.

For CLI/service changes, run at least the focused CLI/core tests plus
`npm run build:ui`. For coordinator, worker, provider, or API changes, run the
relevant focused tests and then `npm test` before handing off. For UI changes,
run focused UI tests, `npm run build:ui`, and Playwright when layout or browser
behavior can regress.

Tests should stub network calls, provider SDKs, long-running workers, and host
service managers unless the test is explicitly an end-to-end check. Avoid
depending on real credentials, installed user services, or a fixed global port.
Use unique `WORKLAB_PORT` values for spawned servers and clean up child
processes in `afterEach` or equivalent teardown.

## Code Change Expectations

Keep changes close to existing module boundaries and preserve established
patterns. Add or update tests for behavior changes. Do not rewrite unrelated
files, generated artifacts, user data, or local service files unless the task
explicitly requires it.

Before finalizing substantial changes, run:

```bash
npm test
npm run build:ui
git diff --check
```

## WORKFLOW RULES (important)

After every change, make sure you commit code granularly.
