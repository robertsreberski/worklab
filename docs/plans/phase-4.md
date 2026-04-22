> Reconstructed 2026-04-22 from commit history (phase-3..phase-4) and spec §8. The phase was executed without a committed plan file; this document preserves the plan intent.

# Worklab — Phase 4 Implementation Plan

**Spec:** `docs/spec/worklab-design.md` §8 "Phase 4 — Multi-SDK, custom providers, encryption" (authoritative).

**Phase plans:** `docs/plans/phase-3.md` (predecessor) · this file · `docs/plans/phase-5.md` (successor).

**Repo root:** `/opt/claude-workspace/local/worklab`. On branch `main` at tag `phase-3`.

**Phase 4 tag:** `phase-4`

**Goal:** You can register an Ollama or any OpenAI-compatible provider, discover its models, assign an agent to use a custom model (e.g. `vercel:<providerId>:gemma3:4b`), and run a task through it end-to-end.

---

## Context

Phase 3 shipped the reviewer loop and knowledge base: tasks with a reviewer agent auto-review, KB entries are managed by humans and agents, and pinned KB entries are injected into agent system prompts.

Phase 4 adds the multi-SDK dispatch layer and custom provider registry. The user motivation is pragmatic: not every workload justifies Claude API billing. Local Ollama models (Gemma, Llama, Mistral, …), OpenRouter, Groq, Together, or a corporate vLLM cluster are all legitimate execution backends. Phase 4 makes any OpenAI-compatible endpoint or Ollama server a first-class provider — registered via the UI, API keys encrypted at rest, models discovered automatically, and agents assignable to any model by name.

Three new execution paths sit behind the existing `generateResponse()` interface in `ai.js`:

1. **Claude Agent SDK** (already present from Phase 2) — `sdk: "claude"`
2. **OpenAI Agents SDK** — `sdk: "openai"`, handled by `ai-openai.js`
3. **Vercel AI SDK** — `sdk: "vercel"`, handled by `ai-vercel.js`; covers Ollama, LM Studio, vLLM, Groq, OpenRouter, Together, Fireworks, DeepSeek, and anything else that speaks OpenAI-compat

Model strings use the form `vercel:<providerId>:<modelName>` or `openai:<tier>`. `resolveModel()` in `ai.js` parses both at runtime and dispatches to the correct path.

---

## Out of scope

The following are explicitly deferred to Phase 5 or later:

- **Consolidation** — nightly MEMORY.md rewrites (`--mode consolidate` worker)
- **Embeddings / semantic search** — `kb_search`, FTS5 tables, `nomic-embed-text`
- **Service install / backup** — `worklab install-service`, `worklab backup`, launchd/systemd
- **Activity page polish** — paginated feed, SSE live-tail in Activity.jsx

---

## Model and review policy

- **Opus 4.7**: T3 crypto (AES-GCM + HKDF — cryptographic correctness matters), T4 multi-SDK dispatch design (routing logic must not silently swallow errors or mis-route models).
- **Sonnet**: T2 provider registry + URL allowlist + discovery, T5 REST routes, T6 UI (Providers page, model picker, cost display) — mechanical wiring, spec-driven.

---

## File structure

### New files

```
src/
  core/
    crypto.js                          — AES-256-GCM encrypt/decrypt + HKDF key management
    providers.js                       — custom provider registry: SQLite CRUD, URL allowlist, discovery
    ai-openai.js                       — OpenAI Agents SDK execution path
    ai-vercel.js                       — Vercel AI SDK execution path (Ollama + OpenAI-compat)
    ai-tools.js                        — shared tool definitions (used by both openai + vercel paths)
    ai-tool-helpers.js                 — low-level tool execution helpers
    ai-vercel-tools.js                 — Vercel-path tool registration wrappers
    cost.js                            — token usage + cost tracking across all three SDKs
  api/
    routes-providers.js                — CRUD: /api/providers, /api/providers/:id/models, discovery
    routes-models.js                   — GET /api/models — aggregated built-in + custom model listing
  ui/src/
    routes/
      Providers.jsx                    — Providers page: provider CRUD, API key, discovery, model toggle
src/__tests__/
  core/
    crypto.test.js                     — encrypt/decrypt round-trips, key auto-generation, fingerprint
    providers.test.js                  — URL allowlist, CRUD, discovery mocks
  api/
    routes-providers.test.js           — REST integration tests for provider + model routes
```

### Modified files

```
src/core/
  ai.js                                — resolveModel() extended; dispatch to openai/vercel paths; cost inject
src/api/
  server.js                            — register routes-providers, routes-models, routes-search (wiring)
src/ui/src/
  routes/
    AgentEdit.jsx                      — model picker: grouped <optgroup> built-in + per-provider; real names
  components/
    EventTimeline.jsx                  — cost + token usage display on run events
  lib/
    api.js                             — provider + model client methods (listProviders, discoverModels, …)
  App.jsx                              — add Providers route + topnav link
  styles.css                           — provider page + model picker + cost display styles
package.json                           — new deps: openai, @openai/agents, @ai-sdk/openai-compatible, ai
package-lock.json                      — lockfile update
```

---

## Tasks

### T1 — AES-256-GCM crypto with HKDF key management

**Commit:** `8b01ef6`

**Files:** `src/core/crypto.js`, `src/__tests__/core/crypto.test.js`

Implements `encrypt(plaintext)` and `decrypt(ciphertext)` using AES-256-GCM. The master key is derived via HKDF from `PROVIDER_ENCRYPTION_KEY` env var, or auto-generated (32 random bytes) on first boot and written to `data/.provider-encryption-key` at `0600` permissions. `getKeyFingerprint()` returns a short hex digest of the master key — used by `worklab doctor` to confirm key presence without exposing the key itself.

Key management semantics:
- Env var (`PROVIDER_ENCRYPTION_KEY`) takes precedence over the file.
- If neither exists, auto-generate and persist to file.
- Deleting the key file and restarting regenerates (fresh key) — all previously encrypted API keys become unreadable. This is documented behavior, not a bug.

**Acceptance criteria:**
- Encrypt → decrypt round-trip returns original plaintext for arbitrary byte strings.
- Key auto-generation writes a file at `0600` with exactly 32 bytes of entropy.
- `PROVIDER_ENCRYPTION_KEY` env override is picked up without touching the file.
- `getKeyFingerprint()` returns a stable hex string for a given key.
- 56 tests pass in `crypto.test.js`.

---

### T2 — Custom provider registry with URL allowlist + model discovery

**Commit:** `796421f`

**Files:** `src/core/providers.js`, `src/__tests__/core/providers.test.js`, `src/api/routes-providers.js`, `src/api/routes-models.js`, `src/__tests__/api/routes-providers.test.js`

Implements the provider registry as a SQLite-backed module (`custom_providers` + `custom_models` tables). Providers have: `id`, `name`, `type` (`ollama` | `openai-compat`), `base_url`, `api_key` (AES-GCM encrypted via `crypto.js`), `trust_public_url` (boolean), `created_at`.

**URL allowlist** — enforced on all provider base URLs:
- Tailscale CGNAT `100.64.0.0/10` — always allowed
- Private LAN ranges `10/8`, `172.16/12`, `192.168/16` — always allowed
- Localhost — always allowed
- Public hosts (non-RFC1918) — require `trust_public_url: true` AND HTTPS

**Model discovery:**
- Ollama: `GET /api/tags` → parse model list
- OpenAI-compat: `GET /v1/models` → parse `data[].id`

REST routes (`routes-providers.js`):
- `GET /api/providers` — list all providers (API keys redacted)
- `POST /api/providers` — create (validates URL allowlist)
- `GET /api/providers/:id` — read
- `PATCH /api/providers/:id` — update
- `DELETE /api/providers/:id` — delete
- `POST /api/providers/:id/discover` — run discovery, upsert models
- `GET /api/providers/:id/models` — list provider's models
- `PATCH /api/providers/:id/models/:modelId` — toggle `enabled`

REST routes (`routes-models.js`):
- `GET /api/models` — aggregated list: built-in Claude tiers + all enabled custom models

**Acceptance criteria:**
- CIDR allowlist blocks `http://evil.example.com` without `trust_public_url`.
- Discover against a mocked Ollama returns model list, upserted into DB.
- Discover against a mocked OpenAI-compat `/v1/models` returns model list.
- API keys are stored encrypted; `GET /api/providers/:id` never returns plaintext key.
- CRUD round-trip: create → read → update → delete.
- 107 providers.test.js + 63 routes-providers.test.js tests pass.

---

### T3 — Multi-SDK dispatch (OpenAI Agents + Vercel AI SDK)

**Commit:** `c0660a1`

**Files:** `src/core/ai.js`, `src/core/ai-openai.js`, `src/core/ai-vercel.js`, `src/core/ai-tools.js`, `src/core/ai-tool-helpers.js`, `src/core/ai-vercel-tools.js`, `src/core/cost.js`, `src/api/server.js`, `src/__tests__/core/ai.test.js`

**`resolveModel(modelStr)` extended** to parse:
- `vercel:<providerId>:<modelName>` — looks up provider by ID, resolves base URL + decrypted API key, constructs Vercel SDK provider instance
- `openai:<tier>` — maps tier strings to OpenAI model IDs

**`generateResponse(params)` dispatch:**
- `sdk === "claude"` → existing Claude Agent SDK path (unchanged)
- `sdk === "openai"` → delegates to `ai-openai.js`
- `sdk === "vercel"` → delegates to `ai-vercel.js`
- Unknown SDK → throws with descriptive error

**`ai-tools.js`** — shared tool definitions (Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch) in a provider-neutral schema format consumed by both `ai-openai.js` and `ai-vercel.js`.

**`ai-tool-helpers.js`** — low-level tool execution: dispatches tool call JSON to the actual filesystem/shell operations, returns structured results. Shared between the two new paths.

**`ai-vercel-tools.js`** — Vercel SDK tool registration: wraps `ai-tools.js` definitions in the `tool()` format expected by the `ai` package, wires execution through `ai-tool-helpers.js`. Also injects all configured MCP servers via `@modelcontextprotocol/sdk`.

**`cost.js`** — extracts and normalises token usage and cost from SDK-specific response shapes into a canonical `{ inputTokens, outputTokens, cacheReadTokens, totalCostUsd }` object. Used by the coordinator to populate `task_runs.cost_usd` and emit `usage` events on the SSE stream.

**`server.js`** modified to register `routes-providers`, `routes-models`, and `routes-search` (the last wired in anticipation of Phase 5 search implementation) and to accept a `consolidationProxy` parameter passed through to `createServer()`.

**Acceptance criteria:**
- `resolveModel("vercel:abc123:gemma3:4b")` resolves provider `abc123` and returns a Vercel-compatible config.
- `resolveModel("openai:sonnet")` maps to the correct OpenAI model ID.
- `generateResponse` dispatches to the correct path for each `sdk` value.
- Vercel path supports all built-in tools (Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch) with the same semantics as the Claude path.
- `cost.js` correctly normalises usage for Claude, OpenAI, and Vercel response shapes.
- 55 updated tests in `ai.test.js` pass.

---

### T4 — Providers UI: Providers page + grouped model picker + cost display

**Commit:** `d9e8568`

**Files:** `src/ui/src/routes/Providers.jsx`, `src/ui/src/routes/AgentEdit.jsx`, `src/ui/src/components/EventTimeline.jsx`, `src/ui/src/lib/api.js`, `src/ui/src/App.jsx`, `src/ui/src/styles.css`, `package.json`, `package-lock.json`

**`Providers.jsx`** — full CRUD page for custom providers and their models:
- Create provider form: name, type (Ollama / OpenAI-compat), base URL, optional API key, trust-public-URL toggle.
- Per-provider model list: discover button (fires `POST /api/providers/:id/discover`), enable/disable toggles per model.
- API key field shows a masked placeholder when a key is already saved; leave blank to keep existing.
- URL validation error surfaced inline before submit.

**`AgentEdit.jsx`** — model picker extended:
- `<select>` replaced with a grouped picker using `<optgroup>` elements.
- Group 1 "Built-in (Claude)" — haiku, sonnet, opus with real model names.
- Groups 2..N — one `<optgroup>` per provider with that provider's enabled models, labeled with real model names (never "Fast/Good/Best" aliases).
- Model strings persist as `claude:<tier>`, `openai:<tier>`, or `vercel:<providerId>:<modelName>`.

**`EventTimeline.jsx`** — cost + token display added to run events:
- `usage` SSE events render as a compact metrics row: input tokens, output tokens, cache read tokens, estimated cost in USD.
- Shown inline after the final `done` event in each run.

**`api.js`** — new client methods: `listProviders`, `createProvider`, `updateProvider`, `deleteProvider`, `discoverProviderModels`, `listProviderModels`, `toggleProviderModel`, `listModels`.

**`App.jsx`** — Providers route added at `#/providers`; topnav link added. (Note: Activity route also wired here, consumed by Phase 5's Activity.jsx.)

**`styles.css`** — new classes for the Providers page layout, model toggle rows, cost metrics row in EventTimeline, and grouped model picker styling.

**`package.json` / `package-lock.json`** — new production dependencies:
- `openai` — OpenAI Agents SDK
- `@openai/agents` — Agents SDK orchestration
- `@ai-sdk/openai-compatible` — Vercel AI SDK OpenAI-compat provider factory
- `ai` — Vercel AI SDK core (`generateText`, `streamText`, `tool`)
- (Phase 5 deps `chokidar` and `vectra` also included in this lockfile bump)

**Acceptance criteria:**
- Navigate to `#/providers` → Providers page renders.
- Create an Ollama provider pointing at `http://localhost:11434` → discover models → enable `gemma3:4b`.
- Open AgentEdit → model picker shows `gemma3:4b` under the provider's group.
- Assign the model, save. Run a task. Events stream. `usage` row renders with token counts.
- Provider API key stored encrypted; page never displays plaintext key after save.

---

## Verification

After all tasks complete:

```bash
# Full test suite (401 tests from phase-3 + new phase-4 tests)
npm test

# Manual smoke:
# 1. worklab start (or npm start)
# 2. Navigate to #/providers
# 3. Create provider: Ollama, http://localhost:11434
# 4. Click Discover → models appear
# 5. Enable a model (e.g. gemma3:4b)
# 6. Open #/agents → edit an agent → model picker shows grouped list
# 7. Select the Ollama model, save
# 8. Create a task, assign the agent, click Run now
# 9. Task runs through Vercel AI SDK path, events stream live
# 10. EventTimeline shows cost/usage row at end of run
# 11. worklab doctor → reports encryption key fingerprint OK

# Encryption round-trip (quick sanity):
node -e "
  import('./src/core/crypto.js').then(({ encrypt, decrypt }) => {
    const c = encrypt('hello world');
    console.assert(decrypt(c) === 'hello world', 'round-trip failed');
    console.log('crypto OK');
  });
"
```

---

## What Phase 5 will add

Phase 5 completes the v1 product:

- **Consolidation** — nightly MEMORY.md rewrites (`--mode consolidate`), per-agent cron, "Consolidate now" button, `agent_consolidations` table.
- **Semantic search** — `embeddings.js` backed by Ollama `nomic-embed-text`, FTS5 hybrid search, `search-indexer.js` filesystem watcher, `kb_search` / `journal_search` / `memory_search` MCP tools.
- **Service install** — `worklab install-service` / `worklab uninstall-service` for macOS (LaunchAgent) and Linux (systemd user unit).
- **Backup** — `worklab backup` produces a timestamped tarball of `data/`; restore by extracting + `worklab start`.
- **Activity page** — paginated run history with status chips, model/effort badges, SSE live-tail.
- **Settings polish** — embedding model picker, consolidation schedule, encryption key status, journal/KB tuning.
