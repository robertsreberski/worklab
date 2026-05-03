# Worklab AI Runtime Bridge

Worklab routes agent execution through canonical runtime bridges. A bridge owns
one runtime transport, normalizes its events and final result, and hides
provider-specific SDK or CLI details from workers and coordinators.

## Canonical Runtime References

Active agent runtime references use only these prefixes:

- `claude:<modelId>` for the Claude Agent SDK bridge.
- `pi:<providerId>:<modelId>` for the Pi Agent SDK bridge.

Current Pi provider examples:

- `pi:openai:gpt-5.5`
- `pi:openai-codex:gpt-5.5`
- `pi:google:gemini-2.5-pro`
- `pi:<customProviderId>:<modelName>`

Reserved ids are not accepted by normal agent/model validation:

- `openai:<model>` is reserved for a future OpenAI-native runtime.
- `codex:<model>` and `codex-cli:<model>` are reserved for future Codex runtimes.
- `vercel:<providerId>:<model>` is reserved for future Vercel runtime work.
- `claude-code:<model>` is reserved for a future Claude Code CLI bridge.

Embedding references are separate from agent runtime references. They may still
use provider ids such as `openai:<embeddingModel>` or
`vercel:<providerId>:<embeddingModel>`.

## Legacy Migration

The migration-only canonicalizer rewrites saved active runtime refs:

- `openai:<model>` -> `pi:openai:<model>`
- `codex:<model>` -> `pi:openai-codex:<model>`
- `vercel:<providerId>:<model>` -> `pi:<providerId>:<model>`
- `claude-code:<model>` -> `claude:<model>`

Database migrations apply this only to current saved configuration:

- `agents.model`
- `agents.sdk`
- `settings.slack_model`
- `settings.assistant_model`

Historical run/log snapshots are not rewritten.

## Bridge Contract

A runtime bridge exposes:

- `id`: canonical runtime id, currently `pi` or `claude`.
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
`@mariozechner/pi-ai`; Worklab custom providers are resolved from the provider
database and converted to Pi-compatible OpenAI-style model descriptors before
execution.

The Claude bridge handles `claude:*` refs through the Claude Agent SDK. It owns
Claude SDK stream interpretation, structured output recovery, runtime warnings,
usage, diagnostics, and post-success SDK error handling.

Dormant CLI/app adapters may exist in `src/ai/providers`, but they are not
registered active runtime bridges until their reserved ids are intentionally
enabled.

## Adding A Runtime

To add a new SDK or CLI:

1. Choose a new canonical runtime id and model reference shape.
2. Add parsing/validation support only for that exact shape.
3. Register a bridge in `src/ai/runtime/registry.js`.
4. Add model catalog entries and credential/readiness reporting.
5. Map Worklab request fields into the SDK/CLI transport.
6. Normalize streaming events to Worklab event shapes.
7. Support structured output through the provider's native mechanism or a
   bridge-local tool equivalent.
8. Return the normalized `RuntimeResult` shape.
9. Keep DB writes, worker spawning, and workflow-state transitions outside the
   provider layer.
10. Add bridge contract, parser, catalog, API, and provider tests.
