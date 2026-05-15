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

  // -- observers (multi-subscriber telemetry) --
  // Optional. Each observer receives every event the runtime emits.
  // Built-in createMetricsObserver() aggregates cost, cache hit rate, token
  // counts, tool-call counts, errors, and turn-latency percentiles.
  observers: [],

  // -- approval gates (HITL) --
  // Optional. When set, the runtime asks the host before every tool call
  // whose risk tier is "medium" or "high" (and not session-allowlisted).
  // See the "Approval gates" section below for the request/response shape.
  onToolApprovalRequest,           // async (req) => { decision, reason? }
  toolRiskTiers: { Bash: "high" }, // per-tool tier override (low|medium|high)
  approvalDefaultRiskTier: "medium",
  approvalTimeoutMs: 60_000,       // timeout → auto-deny
  approvalAlwaysAllowTools: [],    // start with these in session allowlist

  // -- host-customisable identity strings (all optional, defaults shown) --
  runtimeBrand: {
    schemaPrefix: "worklab",       // prefix for snapshot/result schema ids
    mcpClientName: "worklab",      // MCP client name reported to MCP servers
    mcpClientVersion: "0.1.0",     // MCP client version
    tempdirPrefix: "worklab-cli-", // mkdtemp prefix for CLI provider scratch dirs
    providerModelPrefix: "worklab",// id prefix for custom Pi providers
    doctorCommand: "worklab doctor", // command suggested in tool error messages
    serviceName: "worklab",        // Codex app-server serviceName
    clientInfoName: "worklab",     // Codex app-server clientInfo.name
    clientInfoTitle: "Worklab",    // Codex app-server clientInfo.title
  },
});
```

`runtimeBrand` lets an external host reskin the package without forking string-by-string. Defaults preserve worklab strings, so worklab itself doesn't need to set anything.

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
  capabilitiesUsed: {                  // what the backend actually did this call
    prompt_cache_active: true|false|null,
    thinking_enabled: true|false|null,
    structured_output_enforced: boolean,
    subagent_invoked: true|false|null,
    mcp_servers_used: string[],
    native_subagents_used: string[],
    tool_compaction_applied: boolean,
    context_compaction_applied: true|false|null,
  },
}
```

`capabilitiesUsed` is the per-call complement to `runtimeCapabilities()`. Tristate fields use `null` to mean "this provider can't tell" — distinct from `false` ("definitely off"). It's also emitted as a `capabilities_resolved` event near the end of the run, so observers can capture it without inspecting the result object.

## Built-in tools

The agent kernel ships with: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`. You select via `allowedTools`. Tool implementations honor:

- `cwd` (required for path-based tools)
- The runtime context's `workspace` / `repoRoot` allow-list (paths outside both, plus `/tmp` and `process.cwd()`, are rejected)
- Output truncation with optional artifact persistence (`{toolArtifactDir}/tool-output/{runId}/...` when `toolArtifactDir` is configured)

Override or extend the tool surface by passing `mcpServers` for MCP-backed tools.

## Structured output

Pass `options.outputSchema` (a JSON Schema). On Claude SDK / Codex app-server / Pi SDK, the runtime wires the schema into the provider's structured-output API. The matched JSON lands in `result.structuredResult`.

The package does **not** validate `structuredResult` against your schema — it only forwards what the provider produced. Hosts run their own validation (Zod, AJV, etc.).

## Observers & metrics

The runtime emits structured events for everything that happens during a run — assistant messages, tool calls, runtime warnings, cache hits/misses, cost updates, provider request start/end, approval lifecycle. Hosts can subscribe via `host.observers[]` (any number) or the simpler `options.onEvent` callback (one subscriber). Both work simultaneously.

A built-in aggregator covers the common metrics:

```js
import { createRuntime, createMetricsObserver } from "@worklab-ai/agent-runtime";

const metrics = createMetricsObserver();
const runtime = createRuntime({ observers: [metrics] });

await runtime.run("...", { model: { sdk: "claude", model: "claude-sonnet-4-6" } });

console.log(metrics.snapshot());
// {
//   events: { total, byType: { tool_use: 5, assistant: 8, ... } },
//   tokens: { input, output, cacheReadTokens, cacheCreationTokens },
//   cost: { cumulativeUsd },
//   cache: { hits, misses, hitRatio, readTokensFromEvents },
//   tools: { callsByName: { Bash: 3, Read: 2 }, errorsByName: { ... } },
//   errors: { total, byKind: { provider_unavailable: 1 } },
//   turns: { count, latencyMsP50, latencyMsP95 },
//   approvals: { pending, granted, denied },
// }
```

Custom observers implement `{ recordEvent(event), recordMetric(metric)?, flush()? }`. Fan-out is synchronous on the hot path; observers that need to do I/O must buffer internally.

Notable new events emitted by the bridges:

- `provider_request_started` / `_completed` — at the boundary of each LLM call (sdk, model, runtime, timestamp, durationMs).
- `cache_hit` / `cache_miss` — when the provider reports cached / cache-creation input tokens.
- `cost_accumulated` — running cost in USD with cumulative token breakdown.

## Approval gates (human-in-the-loop)

Pass `onToolApprovalRequest` to gate tool calls behind a runtime approval. The runtime calls your callback once per tool invocation whose risk tier requires it, and pauses the agent until you respond.

```js
const runtime = createRuntime({
  toolRiskTiers: { Bash: "high", Read: "low" },
  async onToolApprovalRequest(req) {
    // req = { requestId, toolName, toolUseId, argumentsSummary, riskTier, model }
    // argumentsSummary is already secret-redacted (API keys, Bearer tokens,
    // and known JSON fields like "api_key" / "password" stripped).
    if (req.toolName === "Bash" && req.argumentsSummary.includes("rm -rf")) {
      return { decision: "deny", reason: "destructive" };
    }
    return { decision: "approve" };
  },
});
```

Tiers (configurable per tool):

- **low** — auto-approved; the callback is not called.
- **medium** (default) — calls the host; if no callback is supplied, auto-approves.
- **high** — calls the host; if no callback is supplied, fails closed (deny).

Responses:

- `{ decision: "approve" }` — allow this call.
- `{ decision: "deny", reason? }` — block; the agent receives a tool error.
- `{ decision: "always" }` — allow + session-allowlist for the run.

Backend coverage: Claude SDK (via `canUseTool`) and Pi SDK (via tool dispatch wrapping). Claude CLI and Codex CLI bridge into their backend's own approval models (`permissionMode` / `approvalPolicy`) — per-call runtime gates aren't available there.

Approval lifecycle is observable via `onEvent`:

- `tool_approval_pending` — emitted before calling the host.
- `tool_approval_granted` — host approved.
- `tool_approval_denied` — host denied, timed out, threw, or no callback for a high-risk tool.

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
