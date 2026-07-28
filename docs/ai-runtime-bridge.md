# Worklab AI Runtime Bridge

Worklab routes agent execution through canonical runtime bridges. A bridge owns
one runtime transport, normalizes its events and final result, and hides
provider-specific SDK or CLI details from workers and coordinators.

## Canonical Runtime References

Active agent runtime references use only these prefixes:

- `claude:<modelId>` for the Claude Agent SDK bridge.
- `pi:<providerId>:<modelId>` for the Pi Agent SDK bridge.
- `codex:<modelId>` for the Codex CLI bridge.

Current Pi provider examples:

- `pi:openai:gpt-5.5`
- `pi:openai-codex:gpt-5.5` (Pi bridge, not CLI)
- `pi:google:gemini-2.5-pro`
- `pi:<customProviderId>:<modelName>`

Current CLI examples:

- `codex:gpt-5.5` (Codex CLI app-server)

Reserved ids are not accepted by strict runtime parsing:

- `openai:<model>` is reserved for a future OpenAI-native runtime.
- `codex-cli:<model>` is reserved for a future alternate Codex CLI runtime.
- `vercel:<providerId>:<model>` is reserved for future Vercel runtime work.
- `claude-code:<model>` is reserved for a future Claude Code CLI bridge.

Embedding references are separate from agent runtime references. They may still
use provider ids such as `openai:<embeddingModel>` or
`vercel:<providerId>:<embeddingModel>`.

## Legacy Migration

The compatibility canonicalizer rewrites legacy refs before persistence at
agent/settings ingress boundaries, and migrations apply the same mapping to
saved active runtime refs:

- `openai:<model>` -> `pi:openai:<model>`
- `codex:<model>` remains `codex:<model>` for agents and is forced to
  `execution_mode='cli'`; SDK-only settings still map legacy `codex:<model>`
  to `pi:openai-codex:<model>`.
- `vercel:<providerId>:<model>` -> `pi:<providerId>:<model>`
- `claude-code:<model>` -> `claude:<model>`

Saved agents with `execution_mode='cli'` and `pi:openai-codex:<model>` are
repaired to `codex:<model>` because `pi:openai-codex` is SDK-only.

Database migrations apply this only to current saved configuration:

- `agents.model`
- `agents.sdk`
- `settings.slack_model`
- `settings.assistant_model`

Historical run/log snapshots are not rewritten.

## Bridge Contract

A runtime bridge exposes:

- `id`: canonical runtime id, currently `pi`, `claude`, or `codex`.
- `supports(ref)`: returns true for refs handled by the bridge.
- `capabilities(ref)`: reports runtime capabilities for UI and execenv logic.
- `execute(systemPrompt, request)`: runs the provider and returns a normalized
  Worklab runtime result.

`RuntimeRequest` includes the normalized model ref, effort, messages, cwd, MCP
servers, tool allowlists, permission mode, output schema, run artifact path,
settings, abort signal, live input queue, and event callback.

`RuntimeResult` includes final text, optional `worklabResult`, usage, duration,
turn count, canonical model reference, runtime id, provider session id,
warnings, diagnostics, failure kind, and error details.

## Current Bridges

The Pi bridge handles all `pi:*` refs. Built-in Pi providers are resolved through
the runtime's Pi façade on `@mono-agent/agent-runtime/ai` — Worklab never imports
`@earendil-works/pi-ai` directly, so pi-ai's version pin and mutable registry stay
inside the runtime. Worklab custom providers are resolved from the provider
database and converted to Pi-compatible OpenAI-style model descriptors before
execution.

The Claude bridge handles `claude:*` refs through the Claude Agent SDK. It owns
Claude SDK stream interpretation, structured output recovery, runtime warnings,
usage, diagnostics, and post-success SDK error handling.

The Codex bridge handles `codex:*` refs through the local Codex CLI app-server
when the agent uses `execution_mode='cli'`. The Pi `openai-codex` provider
remains SDK-only and is routed through the pi-native bridge.

## Adding A Runtime

To add a new SDK or CLI:

1. Choose a new canonical runtime id and model reference shape.
2. Add parsing/validation support only for that exact shape.
3. Register a bridge in the shared `@mono-agent/agent-runtime` package.
4. Add model catalog entries and credential/readiness reporting.
5. Map Worklab request fields into the SDK/CLI transport.
6. Normalize streaming events to Worklab event shapes.
7. Support structured output through the provider's native mechanism or a
   bridge-local tool equivalent.
8. Return the normalized `RuntimeResult` shape.
9. Keep DB writes, worker spawning, and workflow-state transitions outside the
   provider layer.
10. Add bridge contract, parser, catalog, API, and provider tests.
