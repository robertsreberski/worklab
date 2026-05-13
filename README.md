# Worklab

![Worklab local AI agent workspace](src/ui/public/about/worklab-about-hero.png)

Worklab is a local, single-user workspace for coordinating AI agents across
projects, tasks, goals, teams, knowledge, providers, and runtime controls. It
runs on your machine, keeps its working data under your local data directory,
and gives you a browser UI for managing agent work without turning every run
into a terminal session.

## Start Worklab

Requirements: Node.js 20 or newer.

From this checkout:

```bash
npm install
npm run install:worklab
worklab onboard
```

Open `http://127.0.0.1:7878`.

`worklab onboard` is the first-run setup wizard. It checks Codex and Claude
Code availability, installs the Worklab host skill into available tools,
configures a local provider such as Ollama or LM Studio, optionally installs
the default embedding model, and finishes with service and doctor checks.

`worklab start` builds the UI, installs or refreshes the per-user service, and
starts Worklab in the background. `worklab onboard` runs it for you unless you
pass `--no-start`. After the first install, your normal startup command is just:

```bash
worklab start
```

Useful service commands:

```bash
worklab status
worklab restart
worklab stop
```

## First Setup

Start in the UI, not in config files:

1. Open **Providers** and confirm the models Worklab can use. Built-in CLI
   models and custom OpenAI-compatible providers can be managed there.
2. Open **Agents** and review the default planner, executor, and reviewer.
   Create additional agents only when you need a distinct role.
3. Open **Teams** when you want lead-cycle coordination across a roster of
   agents, with a lead agent responsible for keeping the work pointed at the
   outcome.
4. Open **Projects** and add the repositories or work directories you want
   Worklab to operate on. If a repo has `AGENTS.md`, Worklab treats it as
   repository instructions for agent prompts.
5. Open **Goals** for longer-lived outcomes tied to a project and team. Goals
   track the objective, north star, stopping condition, validation loop, and
   lead-cycle context that should shape related work.
6. Open **Tasks** and create the work you want the agents to plan, execute, and
   review.
7. Use **Knowledge** for durable notes that agents should reuse, and **Settings**
   for runtime, search, Slack, MCP, notification, and assistant controls.

Runtime data defaults to `~/.worklab`; task workspaces default to
`~/worklab-workspace`.

## Daily Use

- Use **Tasks** as the active work queue.
- Use **Goals** to keep larger project outcomes, north-star criteria, and
  recurring lead-cycle decisions visible.
- Use **Runs** to inspect completed runs and historical output.
- Use **Projects** to keep repo context, allowed agents, task progress, and
  project knowledge together.
- Use **Teams** to manage lead agents, member agents, budgets, and project goal
  assignments.
- Use the assistant dock in the UI for quick questions against the current
  Worklab view.

Agents that need stdio MCP access to Worklab can run:

```bash
worklab mcp
```

## Configuration

Worklab loads `.env` from the active data directory, while shell environment
variables and CLI flags take precedence.

Common overrides:

```bash
WORKLAB_PORT=9000
WORKLAB_HOST=127.0.0.1
WORKLAB_DATA_DIR=/tmp/worklab-dev
WORKLAB_WORKSPACE=/tmp/worklab-workspace
WORKLAB_LOG_LEVEL=info
```

CLI flags are passed after the command:

```bash
worklab start --port 9000
worklab restart --port 9000
worklab serve --port 9000 --data-dir /tmp/worklab-dev
```

`worklab start` and `worklab restart` regenerate the host service definition
with the effective host, port, data directory, workspace, and log level.

## Development

For a foreground API/static server from this checkout:

```bash
npm run dev:api
```

For UI hot reload, run the API and Vite UI in separate terminals:

```bash
npm run dev:api
npm run dev:ui
```

Open the Vite URL, normally `http://127.0.0.1:5173`. `worklab serve`,
`npm start`, and `npm run dev:api` serve the built UI from `src/ui/dist`; Vite
is the hot-reload path for `src/ui`.

## Tailnet Access

Keep Worklab bound to localhost and use Tailscale Serve for tailnet-only access:

```bash
worklab start
tailscale serve --bg --yes --http 7878 7878
tailscale serve status
```

Use the MagicDNS URL shown by `tailscale serve status`. Raw Tailscale IP
requests can return a Serve 404 because Serve routes by hostname.

Disable the proxy with:

```bash
tailscale serve --http=7878 off
```

## Testing

Run the full suite:

```bash
npm test
```

Useful focused checks:

```bash
npm run build:ui
npm run lint
npm run lint:size
./scripts/guard-imports.sh
```

Browser regressions use Playwright against a freshly built UI:

```bash
npm run test:e2e:ollama
```

See [AGENTS.md](AGENTS.md) for repository instructions and testing expectations.

## License

GPLv3. See [LICENSE](LICENSE).
