# Worklab

![Worklab local AI agent workspace](src/ui/public/about/worklab-about-hero.png)

Worklab is a local, single-user workspace for coordinating AI agents across
projects, tasks, goals, teams, knowledge, providers, and runtime controls. It
runs on your machine, keeps its working data under your local data directory,
and gives you a browser UI for managing agent work without turning every run
into a terminal session.

## Start Worklab

Requirements: Node.js 22.19.0 or newer.

Install the CLI from npm:

```bash
npm install -g @worklab-ai/worklab
worklab onboard
```

Open `http://127.0.0.1:7878`.

For development from this checkout:

```bash
npm install
npm run install:worklab
worklab onboard
```

`worklab onboard` is the first-run setup wizard. It checks Codex and Claude
Code availability, installs the Worklab host skill into available tools,
guides hosted auth setup, configures a local provider such as Ollama or LM
Studio, optionally installs the default embedding model, and finishes with
service and doctor checks.

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

## Auth And Embeddings

Worklab can run with only local providers, but hosted models need credentials.
`worklab onboard` reports what is missing and prints the exact follow-up
commands.

Pi OpenAI Codex auth:

```bash
worklab auth pi openai-codex
```

This starts the Pi OAuth flow and stores credentials in
`~/.worklab/pi-auth.json`. If you use a custom data directory, pass the same
`--data-dir` flag you use for the service. `OPENAI_CODEX_API_KEY` or
`CODEX_API_KEY` still take precedence when set.

OpenAI API key auth:

1. Create an API key in the OpenAI dashboard:
   <https://platform.openai.com/api-keys>
2. Add it to the active Worklab data directory:

   ```bash
   echo 'OPENAI_API_KEY=sk-...' >> ~/.worklab/.env
   worklab restart
   ```

`OPENAI_API_KEY` enables OpenAI API-backed models and optional OpenAI
embeddings. During onboarding you can choose local embeddings, OpenAI
embeddings, or no embeddings:

```bash
worklab onboard --embedding local
worklab onboard --embedding openai
worklab onboard --embedding no
```

OpenAI embeddings use `openai:text-embedding-3-small` by default. Local
embeddings use Ollama `nomic-embed-text` or an embedding-capable LM Studio
model when available.

OpenCode Zen / Go subscription:

OpenCode Zen is a hosted OpenAI-compatible gateway. The **OpenCode Go** tier
($5/mo) covers its open-source models; **Zen** is pay-as-you-go for the curated
set — both share one API key. Add it as a custom provider, not via auth env vars:

1. Sign in at <https://opencode.ai/zen>, add billing, and copy your API key.
2. In the UI open **Providers → Add provider**, pick **OpenCode Zen** (base URL
   `https://opencode.ai/zen/v1` is prefilled), paste the key, and save.
3. Click **Test**, then **Discover** to populate models (a curated seed list is
   used if the gateway has not yet exposed model discovery), and enable the ones
   you want. They then appear in the **Agents** model picker as
   `pi:<providerId>:<model>`.

Only Zen's OpenAI-compatible models (open-source, GPT, Gemini) are reachable
this way; Anthropic/Claude models on Zen use a separate endpoint and are not
covered.

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

## External Agents Over ACP

Worklab can run external agents through ACP v1 over stdio. Open **Agents**,
choose **New agent**, then either import a discovered mono-agent source or add a
generic ACP process manually. Imported mono-agents keep their configuration,
workspace, MCP, and session policy agent-owned; Worklab stores only the
sanitized discovery descriptor and launches the exact bridge argv without a
shell. Set `WORKLAB_MONO_AGENT_BIN` when the `mono-agent` executable is not on
the Worklab service `PATH`.

Discovery lists compatible running sources and leaves older, incompatible
sources visible as **Upgrade required**. A mono-agent process advertises its
bridge contract when that source starts, so a legacy source must be upgraded
and restarted before Worklab can import it. Worklab does not restart or alter
the discovered source. Import is also blocked for stopped or unhealthy
sources.

A generic profile stores an absolute executable path, argv, working directory,
environment-variable names, ownership choices, session resume strategy, and a
bounded probe timeout. It never stores environment values and launches the
executable directly rather than through a shell. Obvious secret-bearing argv
flags are rejected, but positional arguments are not a credential store;
provide credentials through named environment variables instead.

The ACP client lives in the shared `@mono-agent/agent-runtime` package. Worklab
owns profile persistence, task scheduling, and the browser interaction inbox.
Permission choices, non-secret elicitation forms, and browser continuation URLs
appear globally while a task or profile operation is waiting. Submitted form
values travel only to the waiting worker process; they are not stored in the
database, run events, logs, or backups.

Agent-owned ACP turns receive task-owned context and file attachments as
`resource_link` blocks. Worklab instructions, memory, knowledge, skills, MCP
servers, tools, repository instructions, and delegation policy are withheld so
the external agent remains authoritative for its own runtime. The current
Worklab client does not provide ACP filesystem, terminal, network, or
client-MCP services, and a generic profile that requests them is rejected.
This is an ACP client-service policy, not an operating-system sandbox: the
external process still has the filesystem, network, and process access granted
to the user account that runs Worklab. ACP profiles currently support task runs
only. An agent-owned workspace must exactly match its canonical workspace and
cannot use a Worklab-created per-run worktree.

The mono-agent integration is an ACP v1 core-session profile: initialization,
sessions, prompts, typed updates, cancellation, text, resource links, and
elicitation are supported. Client-supplied MCP servers remain unsupported, so
the bridge is not described as a generally conformant ACP Agent.

Probe, authentication, logout, session-list, and session-delete controls run as
asynchronous operations, with at most one active operation per profile. The
profile timeout bounds startup and active operation work; it pauses while the
operation is waiting for a browser interaction and is rearmed when work
resumes. Cancellation aborts the operation and uses a bounded cleanup wait. On
startup, Worklab marks queued, running, or interaction-waiting operations left
by the previous process as failed with `coordinator_restarted` and expires
their unresolved interactions instead of silently resuming them.

Provider session identifiers are opaque, profile-bound handles. Worklab may
persist and return the opaque handle for resume, listing, and deletion, but raw
remote session IDs are removed from operation results, task-run events, logs,
and backups. A handle from one profile cannot be used against another.

### Browser And Network Boundary

State-changing `/api` requests, plus the process-starting mono-agent discovery
read, must come from the Worklab browser UI with a trusted `Origin`/`Referer` or
use the local service bearer token. If a reverse proxy or split UI needs an
additional browser origin, set `WORKLAB_ACP_ALLOWED_ORIGINS` to a comma-separated
list of exact HTTP(S) origins, including scheme and port when non-default. Paths
and wildcard origins are not supported.

This check is CSRF and browser-source protection, not network authentication or
a user login. It does not make a non-loopback Worklab listener safe for public
exposure, and read-only API routes are not made private by the absence of CORS
headers. Keep the service on loopback or enforce the intended users and devices
at a trusted reverse proxy or tailnet boundary.

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

## Useful Commands

| Command | Purpose |
| --- | --- |
| `worklab onboard` | First-install wizard for tools, skills, auth guidance, providers, embeddings, service startup, and doctor checks. |
| `worklab auth pi openai-codex` | Create Pi OAuth credentials for OpenAI Codex under the active data directory. |
| `worklab install-skill --target codex\|claude\|all` | Install the Worklab host skill into Codex or Claude Code. |
| `worklab start` | Build the UI, install or refresh the user service, and start Worklab. |
| `worklab status` | Show service, coordinator, health, and runtime configuration status. |
| `worklab restart` | Rebuild the UI and restart the managed service. |
| `worklab stop` | Stop the managed service. |
| `worklab doctor` | Check runtime health, service wiring, database integrity, MCP config, and embeddings. |
| `worklab doctor performance` | Measure endpoint timings, response sizes, database size, and large event logs. |
| `worklab mcp` | Run the full-access Worklab admin MCP bridge over stdio. |
| `worklab update --apply --version <latest>` | Apply a supported global npm update and restart the service. |
| `worklab backup` | Create a credential-scrubbed tar.gz backup of the active data directory. |
| `worklab compact-logs --apply` | Compact old large SQLite run logs while preserving raw JSONL logs. |

### Backups And Credentials

`worklab backup` preserves application state while deliberately leaving known
credentials out of the portable archive. It excludes
`.env`, `pi-auth.json`, the legacy `auth.json`, `.provider-encryption-key`,
`mcp-token`, `push-vapid.json`, and `config/mcp.json` (which can contain inline
environment variables, headers, or arguments). It also removes encrypted
custom-provider API keys, browser push subscriptions, inbound webhook IDs, and
legacy raw ACP session identifiers from the database copy. Restored webhook
automations are disabled and marked for reconfiguration. Runtime `logs`,
`.coordinator.pid`, and SQLite WAL/SHM files remain excluded as before.

This is credential scrubbing, not general content redaction. Tasks, comments,
instructions, knowledge, agent memory, attachments, run results, and other
application content remain in the archive and may be sensitive. Treat every
backup as private data.

The backup directory is mode `0700` and each archive is mode `0600`. After a
restore, reconfigure provider/API and Pi OAuth credentials, MCP servers,
inbound webhook automations, and browser notifications before restarting
Worklab; Worklab will generate a new service token, provider-encryption key,
and VAPID key as needed. The output directory must be outside the active
Worklab data directory.

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
WORKLAB_MONO_AGENT_BIN=/absolute/path/to/mono-agent
WORKLAB_ACP_ALLOWED_ORIGINS=https://worklab.example.ts.net
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

Tailscale Serve changes how Worklab is reached; it does not add a Worklab user
authentication layer. A browser that can open the same-origin MagicDNS UI can
also submit Worklab mutations, including starting tool-capable local or ACP
agents. Restrict access with Tailscale ACLs/grants and device/user controls, and
do not treat `WORKLAB_ACP_ALLOWED_ORIGINS` as a substitute for that access
policy.

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
npm run pack:check
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
