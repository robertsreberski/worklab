# Agent Runtime Architecture

## What It Is

`@worklab-ai/agent-runtime` is Worklab's provider-agnostic agent execution
kernel. It does not own tasks, database state, UI, scheduling, or Worklab's
domain-specific result contract. It owns the lower-level act of running an
agent turn:

- pick the right backend from a model reference and execution mode
- expose built-in tools, MCP tools, approvals, structured output, and live input
- normalize provider events into one runtime event stream
- classify runtime failures and retryable provider errors
- collect usage, cost, cache, capability, and warning telemetry
- return raw text plus raw structured output to the host

Worklab consumes the package mainly through `src/core/ai.js`, while the package
entry point is `src/runtime.js`.

## Package Boundary

```mermaid
flowchart TB
  Worklab["Worklab host app<br/>API / coordinator / worker / UI / DB"] --> CoreAI["src/core/ai.js<br/>generateResponse()"]

  CoreAI --> Runtime["agent-runtime<br/>createRuntime() / createRouterRuntime()"]

  Runtime --> Registry["Runtime bridge registry<br/>model ref + executionMode -> backend"]
  Runtime --> AgentKernel["Agent kernel<br/>built-in tools, MCP, approvals,<br/>compaction, transcript snapshots"]
  Runtime --> Observability["Observers + metrics<br/>usage, cost, events, warnings"]
  Runtime --> Failure["Failure taxonomy<br/>retryable provider detection"]

  Registry --> ClaudeSDK["Claude SDK bridge"]
  Registry --> ClaudeCLI["Claude Code CLI bridge"]
  Registry --> PiSDK["Pi SDK bridge<br/>OpenAI, Codex, Gemini, OpenRouter,<br/>Ollama, custom providers"]
  Registry --> CodexApp["Codex app-server CLI bridge"]

  AgentKernel --> Builtins["Read / Write / Edit / Glob / Grep / Bash<br/>WebFetch / WebSearch"]
  AgentKernel --> MCP["MCP stdio / SSE / HTTP tools"]
  AgentKernel --> Artifacts["Tool-output bloat guard<br/>host artifact persistence"]

  ClaudeSDK --> Providers["External model/provider surfaces"]
  ClaudeCLI --> Providers
  PiSDK --> Providers
  CodexApp --> Providers

  Runtime --> Result["RuntimeResult<br/>text, structuredResult, events,<br/>usage, diagnostics, failureKind"]
  Result --> CoreAI
  CoreAI --> WorklabContract["Worklab parses domain contract<br/>worklab.v2 / assistant result / task effects"]
```

The runtime stays below Worklab domain behavior. Provider code in this package
must not import Worklab DB, API, coordinator, or UI modules. Worklab passes
host callbacks and pre-resolved settings into the runtime instead.

## Runtime Selection

```mermaid
flowchart LR
  ModelRef["options.model<br/>claude:* / pi:*:* / codex:*"] --> Parse["parseRuntimeModelReference()"]
  Parse --> Mode["options.executionMode<br/>sdk or cli"]
  Mode --> Resolve["resolveRuntimeBridge()"]

  Resolve -->|sdk=claude + sdk mode| ClaudeSDK["claude bridge<br/>@anthropic-ai/claude-agent-sdk"]
  Resolve -->|sdk=claude + cli mode| ClaudeCLI["claude-code bridge<br/>claude binary"]
  Resolve -->|sdk=pi| PiSDK["pi bridge<br/>@earendil-works/pi-agent-core"]
  Resolve -->|sdk=codex + cli mode| CodexApp["codex-app bridge<br/>codex app-server"]

  Resolve --> Caps["runtimeCapabilities()<br/>static backend features"]
  Caps --> Used["capabilitiesUsed<br/>per-call observed features"]
```

Canonical active model references are:

- `claude:<modelId>` for Claude SDK or Claude Code CLI, selected by
  `executionMode`
- `pi:<providerId>:<modelName>` for Pi SDK providers
- `codex:<modelId>` for Codex app-server CLI

Legacy aliases are canonicalized at host ingress when needed. The strict parser
keeps the package boundary honest by rejecting reserved runtime IDs such as
`openai:*`, `vercel:*`, and `claude-code:*`.

## Run Lifecycle

```mermaid
sequenceDiagram
  participant Host as Worklab host
  participant Runtime as createRuntime()
  participant Registry as Bridge registry
  participant Bridge as Provider bridge
  participant Kernel as Agent kernel
  participant Provider as SDK / CLI / app-server
  participant Observer as Observer hub

  Host->>Runtime: run(systemPrompt, options)
  Runtime->>Registry: resolveRuntimeBridge(model, executionMode)
  Registry-->>Runtime: bridge.execute()
  Runtime->>Observer: create hub from host + call observers
  Runtime->>Bridge: execute(systemPrompt, normalized options)

  Bridge->>Kernel: prepare tools, MCP, approvals, limits
  Kernel-->>Bridge: provider-specific tool surface
  Bridge->>Provider: send prompt, messages, tools, schema, settings

  loop streaming events
    Provider-->>Bridge: assistant/tool/result/provider events
    Bridge->>Observer: normalized runtime events
    Bridge->>Kernel: execute built-in/MCP tools as needed
    Kernel-->>Bridge: tool results or tool errors
  end

  Bridge-->>Runtime: RuntimeResult
  Runtime->>Observer: flush()
  Runtime-->>Host: text, structuredResult, events, usage, diagnostics
  Host->>Host: validate/parse Worklab-specific contract
```

The package forwards provider structured output as `structuredResult`, but it
does not validate that output against Worklab's domain schema. Hosts own that
validation and any state-machine side effects.

## Main Subsystems

```mermaid
flowchart TB
  Public["Public API<br/>src/index.js"] --> RuntimeFactory["runtime.js<br/>createRuntime()"]
  Public --> Router["ai/runtime/router.js<br/>createRouterRuntime()"]
  Public --> AIExports["ai/index.js<br/>model refs, registry, observers"]
  Public --> AgentExports["agent/index.js<br/>allowlists, compaction,<br/>approvals, transcript"]

  RuntimeFactory --> Registry["ai/runtime/registry.js"]
  Registry --> Providers["ai/providers/*"]

  Providers --> Claude["claude-sdk.js"]
  Providers --> ClaudeCode["claude-cli.js"]
  Providers --> Pi["pi-sdk.js<br/>pi-models/messages/events"]
  Providers --> Codex["codex-app.js"]

  AgentExports --> Tools["agent/tools/*"]
  Tools --> ToolRuntime["shared/runtime-context.js<br/>workspace, repoRoot, rg, brand"]
  Tools --> PiBridge["tools/pi-bridge.js<br/>built-ins + MCP adaptation"]

  AgentExports --> Compaction["agent/compaction.js"]
  AgentExports --> Transcript["agent/transcript.js"]
  AgentExports --> Approval["agent/approval.js"]
  AgentExports --> Bloat["agent/tool-bloat.js"]

  AIExports --> Failure["ai/failure.js"]
  AIExports --> Cost["ai/cost.js"]
  AIExports --> Observer["ai/observer.js"]
  AIExports --> Capabilities["ai/runtime/capabilities*.js"]
```

Key responsibilities by subsystem:

- `runtime.js`: binds host callbacks once, configures tool runtime context, and
  routes each call to the resolved bridge.
- `ai/runtime/registry.js`: maps model reference plus execution mode to one of
  the built-in provider bridges.
- `ai/runtime/router.js`: retries across an ordered fallback chain on retryable
  provider failures, carrying a transcript-tail resume snapshot forward.
- `ai/providers/*`: owns provider-specific request shapes, event conversion,
  structured-output extraction, native subagent wiring, usage, and diagnostics.
- `agent/tools/*`: implements built-in tools, path/workdir guards, MCP tool
  adaptation, Playwright artifact routing, and output limits.
- `agent/compaction.js`: estimates context pressure and compacts long agent
  conversations for providers that support the package's compaction loop.
- `agent/transcript.js`: builds bounded resume snapshots from prior provider
  events so a fallback or continuation can keep context.
- `agent/approval.js`: provides host-driven human-in-the-loop tool approval
  gates where the backend supports runtime tool dispatch.
- `ai/failure.js`: normalizes spawn, usage-limit, provider, cancellation, and
  retryability decisions into stable failure kinds.

## Host Responsibilities

```mermaid
flowchart LR
  Host["Host app"] --> Pricing["resolveCustomPricing"]
  Host --> Auth["resolvePiApiKey"]
  Host --> Persist["persistArtifact"]
  Host --> Compact["onCompactionRecorded"]
  Host --> Approval["onToolApprovalRequest"]
  Host --> Brand["runtimeBrand"]
  Host --> Roots["workspace / repoRoot / ripgrepPath"]

  Pricing --> Runtime["agent-runtime host callbacks"]
  Auth --> Runtime
  Persist --> Runtime
  Compact --> Runtime
  Approval --> Runtime
  Brand --> Runtime
  Roots --> Runtime

  Runtime --> Raw["Raw runtime result"]
  Raw --> Domain["Host-owned domain validation<br/>Worklab result contract, state machine,<br/>DB writes, UI surfaces"]
```

The host is responsible for:

- resolving credentials and custom provider/model rows before provider calls
- choosing model references, execution mode, effort, fallback chains, and
  runtime settings
- persisting artifacts, compaction rows, raw logs, run rows, and UI-facing state
- validating structured output against the host's domain contract
- converting runtime failures into product workflow behavior
- deciding when to retry, recover, continue, cancel, or ask for user input

## Essential Takeaway

Think of `@worklab-ai/agent-runtime` as the portable agent process engine
underneath Worklab. Worklab decides what a task means, which agent should run,
how state changes, and how results are persisted. The runtime decides how to
talk to Claude, Pi, and Codex execution surfaces; how tools are exposed; how
provider failures are normalized; and how enough telemetry is returned for a
host to make reliable orchestration decisions.
