# `@worklab-ai/agent-runtime` × zeroclaw uplift — comparison & design

**Status**: approved, in implementation
**Author**: Robert (with Claude)
**Date**: 2026-05-15
**Branch**: `agent-runtime-zeroclaw-uplift`

---

## Why this doc exists

`@worklab-ai/agent-runtime` is the JavaScript agent runtime that powers Worklab and is published as an npm package so other apps can embed it. We want it to be the best embeddable JS agent runtime on the market — most versatile and polished. To raise the bar, we did a thorough comparison against [`zeroclaw-labs/zeroclaw`](https://github.com/zeroclaw-labs/zeroclaw), a very active (31.3k★, v0.7.5 last week) agent runtime. This doc captures what we learned, the five ideas we're stealing, and what we're deliberately leaving alone.

## The two products in one paragraph

Zeroclaw is a Rust **runtime application**: a single binary that you install, configure with a TOML file, and run as a daemon. It bundles 40+ channel adapters (Discord, Telegram, Matrix, email, voice, webhooks), an SOP (Standard Operating Procedure) engine triggered by MQTT/cron/GPIO, a dashboard, hardware integration on RPi/STM32/ESP32, and ACP support for IDEs. `@worklab-ai/agent-runtime` is a JavaScript **library**: hosts embed it via `createRuntime()` and own their own UI, scheduling, channels, and persistence. Feature parity with zeroclaw would mean turning our package into a different product, which we are not doing. Concept parity is what matters.

## What we already do well (preserve, don't churn)

| Capability | Where | Notes |
|---|---|---|
| Multi-backend routing (4 backends) | `src/ai/runtime/registry.js` | Claude SDK, Claude CLI, Pi SDK, Codex CLI |
| Aggressive context compaction | `src/agent/compaction.js` | 85% trigger, summarises discarded prefix, ~25 tunables |
| Transcript-tail resume snapshots | `src/agent/transcript.js` | Survives provider drops on SDK-mode |
| 22-kind failure taxonomy + retryability classifier | `src/ai/failure.js` | `retryableProviderFailureInfo` exists but unused (see Pick 3) |
| Tool-bloat with artifact persistence | `src/agent/tool-bloat.js` | 256 KB cap, host `persistArtifact` callback |
| Lenient JSON recovery on structured output | `src/ai/result/lenient-parse.js` | Saves runs from `invalid_result` |
| MCP transports built in | `src/agent/tools/pi-bridge.js` | stdio / SSE / HTTP |
| Native Claude subagents | `src/ai/providers/claude-subagents.js` | |

These are real moats. The picks below add to them; they don't refactor them.

## Side-by-side comparison

| Capability | zeroclaw | `@worklab-ai/agent-runtime` | Gap? |
|---|---|---|---|
| Provider abstraction | `Provider` trait, 20+ implementations | 4 backends via registry | Comparable surface area, very different breadth |
| Approval gates (HITL) | `ApprovalManager` with session allowlist, three-decision response, timeout → deny | Pre-config permission mode only; no runtime pause | **Real gap — Pick 1** |
| Observability | `Observer` trait, multi-subscriber, event taxonomy with `CacheHit` / `LlmRequest` / `CostUsd` | Single `onEvent` callback; cost only in final result; no cache events | **Real gap — Pick 2** |
| Provider fallback | Hint-based router, **no auto-fallback** | Single-provider retry classifier exists but isn't wired | **Real gap — Pick 3** (we can leapfrog) |
| Per-call capability introspection | Static `ProviderCapabilities` per provider | Static per backend; nothing per call | **Real gap — Pick 4** |
| Context compaction | Basic (none surfaced in survey) | Proactive, summarising, ~25 tunables | We win |
| Resume / transcript | None surfaced | Transcript-tail snapshot + render | We win |
| Failure taxonomy | `anyhow::Result`, `ObserverEvent::Error` | 22 named kinds + retryability classifier | We win |
| MCP support | Tools-only ("custom MCP servers") | stdio / SSE / HTTP, integrated into Pi bridge + Claude SDK | Comparable |
| Tool sandboxing | Workspace/command policies, OS sandboxes (Docker/Firejail/Landlock/Seatbelt) | Workspace/repoRoot allow-list, output cap, artifact persistence | We're software-level only; zeroclaw goes OS-level. Out of scope for a JS lib. |
| Channels (Discord, Telegram, etc.) | 40+ | None | Out of scope — host's job |
| SOP engine | First-class, MQTT/cron/GPIO triggers | None | Out of scope — host's job |
| Dashboard | Built-in | None (Worklab ships its own UI) | Out of scope |
| Hardware (GPIO/I2C/SPI/USB) | First-class on RPi/STM32/ESP32 | None | Out of scope — Node |
| Single-binary deployment | Yes | N/A | N/A for npm package |
| Tool receipts / audit log | SD-JWT *Verifiable Intent* credentials (payment authorisation) | Event log + artifact persistence | Not a fit — zeroclaw's "receipts" are about payments, not general audit |
| Branding / extraction | Trait-driven API crate, host-agnostic | `worklab.*` strings & schema IDs in package | **Polish gap — Pick 5** |

## The five picks (in implementation order)

### Pick 5 — Extraction polish (`runtimeBrand`)

**The steal**: Zeroclaw's `crates/zeroclaw-api/` is a self-contained trait crate with no host names baked in. Our package has `worklab.transcript-tail.v1`, `"worklab-cli-"`, `"worklab/${name}"` MCP client names, `clientInfo.name = "worklab"`, and `"worklab doctor"` strings spread across providers. A first external adopter would patch every one of these.

**The adaptation**: Add `runtimeBrand` to `createRuntime(host)` with sensible defaults (`packageName: "@worklab-ai/agent-runtime"`, `schemaPrefix: "worklab"`, `mcpClientName: "worklab"`, `tempdirPrefix: "worklab-cli-"`). Replace hardcodes with reads from the resolved brand. Default behaviour is preserved; external hosts override.

**Why first**: Smallest pick. Unblocks the adoption narrative for the entire effort.

### Pick 1 — Approval gates (HITL runtime)

**The steal**: Zeroclaw's `ApprovalManager` (`crates/zeroclaw-runtime/src/approval/mod.rs`) with three-decision response (`Approve` / `Deny` / `AlwaysApprove`), per-request UUID, session-scoped allowlist, and timeout → auto-deny.

**The adaptation**: New `onToolApprovalRequest?: (req) => Promise<response>` host callback. New `src/agent/approval.js` with `createApprovalManager()` that exposes `request(toolCall)`. Per-tool **risk tier** config (`low` / `medium` / `high`) on the allowlist surface — `low` auto-approves, `medium` calls the host, `high` requires the host or fails closed. New events `tool_approval_pending` / `_granted` / `_denied`. Timeout default 60s → auto-deny with reason `approval_timeout`.

**Wired into**: All four providers (`claude-sdk`, `pi-sdk`, `codex-app`, `claude-cli`) and the Pi tool bridge.

### Pick 2 — Observer registry + streaming telemetry

**The steal**: Zeroclaw's `Observer` trait (`crates/zeroclaw-api/src/observability_traits.rs`) with multi-subscriber fan-out and an event taxonomy including `CacheHit`, `CacheMiss`, `LlmRequest`/`LlmResponse`, and `AgentEnd { cost_usd }`.

**The adaptation**: New `host.observers?: Observer[]`, backward-compatible with the existing single `onEvent` callback (registered automatically as one observer). New `src/ai/observer.js` exporting the interface + a built-in `createMetricsObserver()` aggregator that produces `{ cumulativeCostUsd, cacheHitRate, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens, turnLatencyP50, turnLatencyP95, toolCallsByName }`. New events emitted from the bridges: `cache_hit`, `cache_miss`, `cost_accumulated`, `turn_latency`, `provider_request_started`, `provider_request_completed`.

**The differentiator vs zeroclaw**: They ship the trait but not an aggregator. We ship both.

### Pick 4 — Per-request capability telemetry

**The steal**: Zeroclaw's `ProviderCapabilities` introspection — applied **per request**, not per provider.

**The adaptation**: Add `result.capabilitiesUsed: { prompt_cache_active, thinking_enabled, structured_output_enforced, subagent_invoked, mcp_servers_used: string[], native_subagents_used: string[], tool_compaction_applied, context_compaction_applied }`. Each provider populates what it can attest to; unknowns are `null`, not `false`. Emit one `capabilities_resolved` event near the end of the run.

**Why this**: Honest cost/feature analysis needs to know *what was actually on this call*, not what the backend supports in general.

### Pick 3 — Provider fallback router

**The steal**: Zeroclaw's `RouterProvider` (`crates/zeroclaw-providers/src/router.rs`) — but **leapfrogged**: they do hint resolution only, never automatic fallback on retryable failure. We do the auto-fallback.

**The adaptation**: New `createRouterRuntime({ host, chain: ModelRef[] })` returning the same `{ run() }` interface as `createRuntime`. On `retryableProviderFailureInfo({ retryable: true })`, retries with the next chain entry, replaying the transcript-tail snapshot we already build. Capability-filtered: chain entries can require `structured_output`/`supports_mcp` and the router skips entries that lack them (via existing `runtimeCapabilities()`). Emits `provider_failover_started` / `_completed`. Returns merged result with `failoverHistory: [{ model, failureKind, requestId }]`.

**Why last**: Largest piece; benefits from Pick 2's events already in place.

## What we deliberately skip (and why)

- **Channels** (Discord/Telegram/email/voice/webhooks) — application-layer. Worklab has Slack already; new channels belong in the host, not the library.
- **SOP engine** — Worklab has automations. SOPs belong in the orchestration layer above the runtime.
- **Dashboard / web UI** — application-layer. Worklab ships its own Preact UI.
- **Hardware GPIO/I2C/SPI/USB** — out of scope for a Node library.
- **Single-binary deployment** — N/A for an npm package.
- **WASM plugin system** — MCP already gives us this.
- **Tool Receipts (cryptographic)** — zeroclaw's "receipts" turned out to be SD-JWT *Verifiable Intent* credentials for payment authorisation, not general tool audit. Adapting this as general-purpose tool-call hash chains is overengineering for our users. Revisit if a compliance customer asks.
- **ACP (IDE protocol)** — interesting but application-layer.
- **Hierarchical / long-term memory** — separate effort; zeroclaw's memory is basic, not the inspiration we'd build on.
- **OS-level sandboxes** (Docker/Firejail/Landlock/Seatbelt) — out of scope for a JS library; hosts can run the runtime inside their own sandbox.

## Sequencing

The picks have light dependencies. Order shipped:

1. **Pick 5** — Extraction polish. Small, unblocks adoption framing.
2. **Pick 1** — Approval gates. Headline feature; self-contained.
3. **Pick 2** — Observer registry + telemetry. Foundation for Picks 3 + 4 events.
4. **Pick 4** — Per-request capabilities. Smaller after Pick 2 lands.
5. **Pick 3** — Provider fallback router. Largest; uses Pick 2's event channel.

Each lands as one logical commit (or stack), per the repo's commit-granularity rule.

## Competitive context

Where the five picks put us vs. the JS-library competitive set:

- **Mastra**: They have memory + RAG + workflows but no transcript-resume, no aggressive compaction, no provider fallback. After this work, we match their observability story and beat them on resilience.
- **Vercel AI SDK**: Strong streaming + UI integration but the runtime layer is thin. We're a more complete agent runtime; they're a UI streaming kit.
- **Claude Agent SDK**: First-party from Anthropic. After Pick 1, our approval gates match their `canUseTool`. After Pick 3, our fallback story beats theirs (single-provider only).
- **OpenAI Agents SDK**: First-party from OpenAI. Their observability is decent; after Pick 2 we match. After Pick 4 we report per-call cache/thinking better than they do (they aggregate at the SDK level).
- **LangChain.js**: Kitchen sink; criticised for cognitive overhead. We stay deliberately lean.

Net result: After these five picks, `@worklab-ai/agent-runtime` is the best-resourced embeddable JS agent runtime for autonomous work — compaction + resume + failure taxonomy + tool-bloat (existing moats) plus approval gates + observer aggregation + provider fallback + per-call capability telemetry + a host-agnostic brand surface.

## Verification

Per `CLAUDE.md`:

```bash
npm test
npm run build:ui
npm run lint
./scripts/guard-imports.sh
./scripts/guard-banned-tokens.sh
git diff --check
```

End-to-end sanity (manual) after each pick is described in the corresponding section of `/Users/robertsreberski/.claude/plans/run-a-thorough-comparison-ancient-wilkes.md`.
