# @worklab-ai/agent-runtime

Generic agent runtime that supports four backends out of the box:

- **Claude SDK** (`@anthropic-ai/claude-agent-sdk`)
- **Claude Code CLI** (the `claude` binary)
- **Pi SDK** (`@mariozechner/pi-agent-core`, used for OpenAI / Codex / Gemini / OpenRouter / Ollama / etc. via Pi providers)
- **Codex CLI** (the `codex` app-server)

Hosts wire in their own pricing, persistence, credential, and compaction-recording callbacks. The runtime returns raw text + raw structured output; hosts that want a domain-specific contract (e.g. `worklab_result`) parse it on their end.

## Install

```bash
npm install @worklab-ai/agent-runtime
```

Peer requirements:

- Node.js ≥ 20
- `claude` CLI on PATH (only for `executionMode: "cli"` with `claude` SDK)
- `codex` CLI on PATH (only for `executionMode: "cli"` with `codex` SDK; override via the `codexAppServerCommand` option)
- `ripgrep` on PATH (or supplied via `ripgrepPath`) — required for the `Glob` and `Grep` built-in tools

## Quick start

```js
import { createRuntime } from "@worklab-ai/agent-runtime";

const runtime = createRuntime({
  // Host integration (all optional)
  workspace: "/path/to/repo",
  ripgrepPath: "/usr/bin/rg",
});

const result = await runtime.run("You are a helpful assistant.", {
  model: { sdk: "claude", model: "claude-sonnet-4-6" },
  executionMode: "sdk",
  messages: [{ role: "user", content: "Read README.md and summarize it." }],
  cwd: "/path/to/repo",
  allowedTools: ["Read", "Bash"],
  maxTurns: 10,
  onEvent: (event) => console.log(event.type),
});

console.log(result.text);
```

## Picking a backend

The runtime picks a backend from `options.model` + `options.executionMode`:

| `model.sdk` | `executionMode` | Backend |
|---|---|---|
| `"claude"` | `"sdk"` (or omitted) | Claude SDK |
| `"claude"` | `"cli"` | `claude` CLI |
| `"pi"` | any | Pi SDK |
| `"codex"` | `"cli"` | Codex app-server CLI |

A `model` reference can be the parsed shape `{ sdk, model, provider? }` or a string (`"pi:openai:gpt-5.5"`, `"claude:claude-sonnet-4-6"`, etc.) that you parse with the package's `parseRuntimeModelReference` helper.

## `createRuntime(host)`

Pass host-level integration once at boot. All keys are optional.

```js
createRuntime({
  // -- host callbacks --
  resolveCustomPricing,    // (parsed) => NormalizedPricing | null
  resolvePiApiKey,         // async (provider) => string | undefined
  persistArtifact,         // ({ filename, buffer, toolName, toolUseId }) => path | null
  onCompactionRecorded,    // (compactionRow) => void

  // -- tool runtime context (process-level config for the tool kernel) --
  workspace,               // primary allowed root for path-based tools
  repoRoot,                // secondary allowed root
  ripgrepPath,             // explicit path to `rg`; falls back to vendored binary, then PATH
  qaOutputDir,             // fallback dir for Playwright MCP filename routing
});
```

Returns:

- `run(systemPrompt, options)` — async, runs one agent turn against the chosen backend.
- `configureTools(next)` — update the tool runtime context after construction.

### `runtime.run(systemPrompt, options)`

Per-call options (a non-exhaustive selection):

| Option | Type | Notes |
|---|---|---|
| `model` | `object \| string` | **Required.** See "Picking a backend". |
| `executionMode` | `"sdk" \| "cli"` | Default `"sdk"`. |
| `messages` | `Message[]` | Conversation history. |
| `cwd` | `string` | Working directory for the agent's tools. |
| `allowedTools` | `string[]` | Built-in tool allowlist. Default: all. |
| `disallowedTools` | `string[]` | Block list. |
| `mcpServers` | `Record<string, McpServerConfig>` | Configured MCP servers (stdio / sse / http). |
| `maxTurns` | `number` | Hard cap on agent turns. |
| `outputSchema` | `JSONSchema` | If set, the agent is asked to produce structured JSON matching this schema. The result lands in `result.structuredResult`. |
| `abortSignal` | `AbortSignal` | Cancel the run. |
| `liveInput` | `LiveInputQueue` | Stream of in-flight user messages (for human-in-the-loop steering). |
| `onEvent` | `(event) => void` | Fired for every event the provider emits (assistant text, tool calls/results, runtime warnings, structured output). |
| `runId` | `string` | Tag this run for downstream callbacks (e.g. `onCompactionRecorded`). |
| `providerSessionId` | `string` | Resume a prior provider session. |
| `runArtifactDir` | `string` | Used by some providers as the Playwright MCP filename target. |
| `piCodexTransport` | `string` | Forwarded to Pi when running OpenAI Codex models. |
| `codexAppServerCommand` | `string` | Override the Codex CLI binary. |
| `codexAppServerArgs` | `string[]` | Override the Codex CLI arguments. |

Returns:

```ts
{
  text: string,                     // raw assistant text
  structuredResult?: any,           // JSON returned via outputSchema (if any)
  structuredResultSource?: string,  // where structuredResult came from
  events: RuntimeEvent[],           // full event stream (for host-side parsing)
  usage: {
    input_tokens, output_tokens,
    cache_read_tokens, cache_creation_tokens,
    cost_usd,
  },
  durationMs: number,
  numTurns: number,
  model: string,
  effort: string,
  sdk: "claude" | "pi" | "codex",
  cancelled: boolean,
  error: string | null,
  errorDetails: object | null,
  failureKind: string | null,
  providerSessionId: string | null,
  runtimeWarnings: RuntimeWarning[],
  diagnostics: object,
}
```

## Built-in tools

The agent kernel ships with: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`. You select via `allowedTools`. Tool implementations honor:

- `cwd` (required for path-based tools)
- The runtime context's `workspace` / `repoRoot` allow-list (paths outside both, plus `/tmp` and `process.cwd()`, are rejected)
- Output truncation with optional artifact persistence (`{toolArtifactDir}/tool-output/{runId}/...` when `toolArtifactDir` is configured)

Override or extend the tool surface by passing `mcpServers` for MCP-backed tools.

## Structured output

Pass `options.outputSchema` (a JSON Schema). On Claude SDK / Codex app-server / Pi SDK, the runtime wires the schema into the provider's structured-output API. The matched JSON lands in `result.structuredResult`.

The package does **not** validate `structuredResult` against your schema — it only forwards what the provider produced. Hosts run their own validation (Zod, AJV, etc.).

## Tool-result bloat handling

`@worklab-ai/agent-runtime/agent/tool-bloat.js` enforces a 256 KB default cap per `tool_result`. When a payload exceeds the cap, the kernel:

1. Calls your `persistArtifact({ filename, buffer, toolName, toolUseId })` callback (if you supplied one).
2. Substitutes a compact text reference in the agent's transcript.
3. Emits a `runtime_warning` with `warning_kind: "tool_payload_truncated"` and the saved-paths array.

Hosts that don't supply `persistArtifact` get the truncation summary but no on-disk capture.

## Context compaction

`@worklab-ai/agent-runtime/agent/compaction.js` provides `createAgentCompactionManager(...)` which the Pi SDK provider invokes automatically. Configure via the agent's settings (`agent_compaction_*` keys). When a compaction completes, the kernel hands a structured row to your `onCompactionRecorded(record)` callback so the host can persist it however it likes.

## Advanced exports

The package exposes its inner pieces via subpath imports:

```js
import { resolveRuntimeBridge, listRuntimeBridges, runtimeCapabilities } from "@worklab-ai/agent-runtime/ai/runtime/registry.js";
import { generateClaudeResponse } from "@worklab-ai/agent-runtime/ai/providers/claude-sdk.js";
import { createAgentCompactionManager, estimateFirstTurnInput } from "@worklab-ai/agent-runtime/agent/compaction.js";
import { configureToolRuntime, readToolRuntime } from "@worklab-ai/agent-runtime/agent/tools/shared/runtime-context.js";
// ...
```

These are stable but treated as advanced API. Most consumers should reach for `createRuntime` first.

## Example consumer

See [`examples/echo-agent/`](../../examples/echo-agent/) for a runnable consumer that imports `@worklab-ai/agent-runtime`, runs a single Claude SDK turn with the Bash tool, and prints the result.

## License

GPL-3.0-only.
