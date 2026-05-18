# Refactor `@worklab-ai/agent-runtime` + extract `@worklab-ai/pi-kernel`

> **Status: parked.** An attempted execution (Commits 1.1 + 1.2 + a partial Commit 1.3) is preserved on the local branch `parked/refactor-7ff02822-39d6-432e-880f-c89aa3d22b5d`. The work landed cleanly through Phase 1 step 1.2 (tests green, lint clean modulo unrelated pre-existing violations) but ran into bundler complications during the public-barrel rewrite — Vite's UI build pulled `node:fs` from `shared/file-change-stats.js` transitively through the consolidated root barrel. The current package surface is healthy as-is; revisit this plan only if the boundary confusion described below starts to bite.

## Context

The `packages/agent-runtime/` workspace package is currently structured as if `src/agent/` were "the agent kernel" — but in practice that folder is a mix of three unrelated things:

1. **Pi-only kernel code** that exists solely because Pi is a raw LLM API with no tool dispatch, no compaction, no resume. Compaction manager (`agent/compaction.js`), the entire tool-implementation set (`agent/tools/{bash,read,write,edit,glob,grep,webfetch,websearch}.js`), the Pi tool bridge (`agent/tools/pi-bridge.js`), structured-output tool, the `live-input-prompt.js` steering helper, and the Pi adapter files (`ai/providers/pi-{sdk,models,messages,events}.js`).
2. **Genuinely shared cross-provider guards**: approval gating (`agent/approval.js`), tool payload truncation (`agent/tool-bloat.js`), transcript-tail resume snapshots (`agent/transcript.js`), allowlist resolution (`agent/allowlists.js`), tool runtime config (`agent/tools/shared/runtime-context.js`), skill index, MCP param normalization.
3. **Provider-agnostic infrastructure** under `src/ai/`: registry, router with failover, model-ref parsing, capabilities, cost, failure taxonomy, observer hub, backend capabilities, file-change-stats, Codex/Claude-CLI streaming normalization.

The Claude SDK, Claude CLI, and Codex CLI bridges either run their own tool loop inside an SDK/subprocess or pull at most a sliver from the "kernel" (Claude SDK imports `summarisePayload` from tool-bloat, `normalizeMcpToolParams` from pi-bridge, and `createApprovalManager`; Claude CLI and Codex import nothing beyond the brand string). This means most of `src/agent/` is implementation detail of the Pi loop hiding under a generic-sounding name.

**Goal:** Make this obvious in the file structure by splitting Pi-only code out into a sibling workspace package `@worklab-ai/pi-kernel`. `@worklab-ai/agent-runtime` is reduced to the provider-agnostic skeleton (registry, router, Claude SDK/CLI + Codex bridges, shared guards, model refs). The two packages communicate through a new explicit `registerBridge()` API on the registry.

User chose: **full split in one pass** + **break the wildcard subpath exports** and force named imports through clean barrels.

---

## Target architecture

### `@worklab-ai/agent-runtime` (after split)

```
packages/agent-runtime/
├── package.json                # exports: "." and "./registry" only — no wildcards
├── src/
│   ├── index.js                # public barrel
│   ├── runtime.js              # createRuntime() — no longer hardcodes Pi
│   ├── runtime-brand.js
│   ├── runtime/                # was src/ai/runtime/
│   │   ├── registry.js         # + registerBridge() public API
│   │   ├── router.js
│   │   ├── model-refs.js
│   │   ├── capabilities.js
│   │   ├── context-windows.js
│   │   ├── fast-mode.js
│   │   └── capabilities-used.js
│   ├── providers/              # was src/ai/providers/, minus Pi files
│   │   ├── claude-sdk.js
│   │   ├── claude-cli.js
│   │   ├── codex-app.js
│   │   └── claude-subagents.js
│   ├── streaming/
│   │   └── codex-events.js     # CLI/Codex stream normalizer (NOT Pi)
│   ├── shared/                 # was scattered across src/agent/ and src/ai/
│   │   ├── approval.js
│   │   ├── tool-bloat.js
│   │   ├── transcript.js
│   │   ├── allowlists.js
│   │   ├── runtime-context.js  # tool config (workspace, ripgrep, brand)
│   │   ├── ripgrep.js          # resolveRgPath — used by doctor + pi-kernel grep
│   │   ├── skill-index.js
│   │   ├── mcp-helpers.js      # NEW: extracted normalizeMcpToolParams
│   │   ├── backend.js
│   │   ├── cost.js
│   │   ├── failure.js
│   │   ├── observer.js
│   │   └── file-change-stats.js
│   └── __tests__/              # only shared/agnostic tests remain
└── examples/echo-agent/        # already exists, no changes
```

Public barrel (`src/index.js`) exposes the union of what `src/ai/index.js` + `src/agent/index.js` + the root export today, minus the Pi-only names. The two intermediate barrels go away.

### `@worklab-ai/pi-kernel` (new)

```
packages/pi-kernel/
├── package.json                # single "." export, depends on agent-runtime
├── README.md
├── src/
│   ├── index.js                # exports + registerPiBridges()
│   ├── sdk.js                  # was ai/providers/pi-sdk.js (generatePiResponse)
│   ├── compaction.js           # was agent/compaction.js (manager + estimateFirstTurnInput)
│   ├── live-input-prompt.js    # was ai/live-input-prompt.js
│   ├── models.js               # was ai/providers/pi-models.js
│   ├── messages.js             # was ai/providers/pi-messages.js
│   ├── events.js               # was ai/providers/pi-events.js
│   ├── tools/
│   │   ├── pi-bridge.js        # getPiBuiltinTools / initPiMcpTools / wrapToolsWithBloatGuard
│   │   ├── structured-output.js
│   │   ├── bash.js, read.js, write.js, edit.js, glob.js, grep.js
│   │   ├── webfetch.js, websearch.js
│   │   └── shared/
│   │       ├── path-resolver.js
│   │       ├── output-truncation.js
│   │       ├── dedup.js
│   │       └── constants.js
│   └── __tests__/
│       ├── sdk.test.js              # was src/__tests__/ai/pi-sdk.test.js
│       ├── compaction.test.js       # merged from two sources (see step 5)
│       ├── pi-bridge.test.js        # moved from agent-runtime/__tests__/agent/
│       └── tools.test.js            # moved from agent-runtime/__tests__/agent/
```

**Registration mechanism:** `agent-runtime/runtime/registry.js` exposes a new `registerBridge(spec)` function. `pi-kernel/src/index.js` exports `registerPiBridges()` which calls `registerBridge` for the `pi` spec (sdk-mode). Worklab bootstrap (`src/core/ai.js`) calls `registerPiBridges()` once at module load. No side-effect-on-import — the contract is explicit.

The `codex-app` spec (which `sdk: "pi" + executionMode: "cli"` agents currently route through, per the `project_pi_sdk_runtime` memory) **stays in agent-runtime** — Codex app-server is a real cross-provider bridge that also serves OpenAI Codex agents. Pi-CLI agents are dispatched to it via model-ref, no Pi-kernel involvement needed.

### Dependency split (package.json)

`agent-runtime/package.json` keeps: `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `zod`.

`pi-kernel/package.json` takes: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@modelcontextprotocol/sdk` (used by pi-bridge for MCP client init), `zod`. Adds peer/direct dep on `@worklab-ai/agent-runtime` (for `registerBridge`, shared helpers).

The worklab root `package.json` keeps `@earendil-works/pi-ai` as a direct dep (already there — verify whether anything in `src/` outside agent-runtime uses it; if only the runtime needs it, drop it from root deps after the split).

---

## Phased implementation

Each numbered step lands as its own commit per the WORKFLOW RULES. The phases are ordered so the tree compiles and tests pass at every boundary.

### Phase 1 — Reshape `agent-runtime` in place (3 commits)

These first three commits don't introduce the new package; they just move files within `agent-runtime` into the target layout. After Phase 1, `agent-runtime` already looks like the post-split version with Pi files temporarily co-located.

**Commit 1.1 — Flatten shared helpers under `src/shared/`.**
- Move: `src/agent/approval.js`, `src/agent/tool-bloat.js`, `src/agent/transcript.js`, `src/agent/allowlists.js`, `src/agent/prompt/skill-index.js`, `src/agent/tools/shared/runtime-context.js`, `src/agent/tools/shared/ripgrep.js` → `src/shared/`.
- Move: `src/ai/backend.js`, `src/ai/cost.js`, `src/ai/failure.js`, `src/ai/observer.js`, `src/ai/file-change-stats.js` → `src/shared/`.
- Extract `normalizeMcpToolParams` from `src/agent/tools/pi-bridge.js` → new `src/shared/mcp-helpers.js`. Update pi-bridge to import from the new location.
- Update all in-package imports.
- Delete the now-empty `src/agent/index.js` and `src/ai/index.js` barrels (their content folds into the root barrel in commit 1.3).

**Commit 1.2 — Promote `ai/runtime/*` → `runtime/*` and `ai/providers/*` → `providers/*` and `ai/streaming/*` → `streaming/*`.**
- Move every file under `src/ai/runtime/` → `src/runtime/`.
- Move `src/ai/providers/{claude-sdk,claude-cli,codex-app,claude-subagents,pi-sdk,pi-models,pi-messages,pi-events}.js` → `src/providers/`. (Pi files move to `src/providers/` for now; Phase 2 lifts them into `pi-kernel`.)
- Move `src/ai/streaming/codex-events.js` → `src/streaming/codex-events.js`.
- Move `src/ai/live-input-prompt.js` → `src/providers/pi-live-input-prompt.js` (temporary Pi-adjacent home; Phase 2 lifts it).
- Update all in-package imports. `runtime.js` line 25 now reads `from "./runtime/registry.js"`.
- The `src/ai/` and `src/agent/` directories are deleted entirely.

**Commit 1.3 — Rewrite the public barrel + drop wildcard subpath exports.**
- `src/index.js` becomes the single public surface: `createRuntime`, `createRouterRuntime`, all model-ref/capability/fast-mode/context-window helpers, registry primitives, cost/failure/observer/backend/file-change-stats, approval/tool-bloat/transcript/allowlists, runtime-context (`configureToolRuntime`, `readToolRuntime`, `readRuntimeBrand`, `resetToolRuntime`), skill-index, ripgrep helper, `normalizeCodexItemEvent`/`normalizeCodexItemType`, `DEFAULT_RUNTIME_BRAND`/`resolveRuntimeBrand`.
- `package.json` exports field shrinks to: `{ ".": "./src/index.js", "./registry": "./src/runtime/registry.js" }` (the `./registry` subpath is for pi-kernel to import the new `registerBridge` API cleanly without dragging in the whole barrel). Wildcards gone.
- Update all 24 worklab-side import sites (mapping table below) to pull named exports from `@worklab-ai/agent-runtime` only.
- Update `eslint.config.js` boundary rules to encode the new layout (no `src/ai/`/`src/agent/` paths).
- `npm run lint`, `npm test`, `npm run build:ui` must all pass before this commit lands.

### Phase 2 — Carve out `pi-kernel` (4 commits)

**Commit 2.1 — Add `registerBridge` API to agent-runtime's registry.**
- `src/runtime/registry.js`: replace the static `builtinBridgeSpecs` object with a mutable `Map`. Seed it with the `claude-code`, `codex-app`, and `claude` entries. **Remove** the `pi` entry — it moves to pi-kernel in 2.2.
- Export `registerBridge({ id, supports, capabilities, load })`. Idempotent on `id` (later registrations replace earlier; log a warning if a different `id` collides on `supports`).
- Export `unregisterBridge(id)` for completeness.
- `resolveRuntimeBridge` iterates the Map in insertion order, preserving today's CLI-before-SDK ordering. Document that registration order matters.
- Add a unit test in `agent-runtime/src/__tests__/runtime-registry.test.js` proving (a) external registration works, (b) ordering is preserved, (c) `resolveRuntimeBridge` throws `unsupported sdk: pi` when pi-kernel isn't registered.

**Commit 2.2 — Create `packages/pi-kernel/` and move all Pi-only code into it.**
- Create `packages/pi-kernel/package.json` with `"name": "@worklab-ai/pi-kernel"`, `"version": "0.1.8"`, deps as listed above, single export `.`, repository/license matching the sibling.
- Move (with `git mv` for history):
  - `packages/agent-runtime/src/providers/pi-sdk.js` → `packages/pi-kernel/src/sdk.js`.
  - `packages/agent-runtime/src/providers/pi-models.js` → `packages/pi-kernel/src/models.js`.
  - `packages/agent-runtime/src/providers/pi-messages.js` → `packages/pi-kernel/src/messages.js`.
  - `packages/agent-runtime/src/providers/pi-events.js` → `packages/pi-kernel/src/events.js`.
  - `packages/agent-runtime/src/providers/pi-live-input-prompt.js` → `packages/pi-kernel/src/live-input-prompt.js`.
  - `packages/agent-runtime/src/agent/compaction.js` (after Phase 1 it's at `src/shared/compaction.js`? No — leave it in original location until this step, then move directly) → `packages/pi-kernel/src/compaction.js`. **Compaction does NOT move to `shared/` in Phase 1.** Keep it at `src/agent/compaction.js` through Phase 1 and move it to pi-kernel here. The Phase 1 commits keep `src/agent/compaction.js` and `src/agent/tools/` as a temporary "pi-bay" inside agent-runtime; only the clearly shared modules promote in 1.1.
  - All `src/agent/tools/` contents → `packages/pi-kernel/src/tools/` (preserve the `shared/` subdirectory inside tools).
- Inside pi-kernel, rewrite imports:
  - References to former `@worklab-ai/agent-runtime` internal paths become imports from `@worklab-ai/agent-runtime` (barrel) or `@worklab-ai/agent-runtime/registry`.
  - Specifically: `createApprovalManager`, `wrapToolsWithApprovalGate`, `summarisePayload`, `MAX_TOOL_RESULT_BYTES`, `BINARY_BLOAT_TOOLS`, `readToolRuntime`, `readRuntimeBrand`, `resolveRgPath`, `normalizeMcpToolParams`, `estimateCost`, `failureKindForPiError`, `runtimeCapabilities`, `formatLiveInputGuidance` (the last is now exported by pi-kernel itself — wait, it lives in pi-kernel now; intra-pkg import).
- `packages/pi-kernel/src/index.js`:
  - Re-export `generatePiResponse`, `piRuntimeBridge`, `formatLiveInputGuidance`, `estimateFirstTurnInput`, `createAgentCompactionManager`, `isLikelyContextTermination`, `getPiBuiltinTools`, `initPiMcpTools`, `createStructuredOutputTool`.
  - Export `registerPiBridges()` — single call that imports `registerBridge` from `@worklab-ai/agent-runtime/registry` and registers the `pi` spec.
- Inside agent-runtime, update `runtime.js` doc comment ("All four built-in bridges register themselves on import" is no longer accurate — rewrite to say three built-in bridges + Pi via external registration).
- The worklab root `package.json` adds `"@worklab-ai/pi-kernel": "0.1.8"` to dependencies. The npm workspaces config already matches `packages/*` so no glob change needed.

**Commit 2.3 — Wire pi-kernel registration into worklab and repoint Pi-only imports.**
- `src/core/ai.js`: at the top, `import { registerPiBridges } from '@worklab-ai/pi-kernel'; registerPiBridges();`. This guarantees registration before any `createRuntime` consumer resolves a Pi bridge. Add a comment explaining why this lives here.
- Update worklab-side imports that pull Pi-specific names:
  - `src/core/live-input.js`: `formatLiveInputGuidance` from `@worklab-ai/pi-kernel`.
  - `src/worker/automation-runner.js`, `consolidate-runner.js`, `agent-turn.js`: `estimateFirstTurnInput` from `@worklab-ai/pi-kernel`.
- For ESLint boundaries: `src/core/`, `src/worker/`, `src/coordinator/` may import from both `@worklab-ai/agent-runtime` and `@worklab-ai/pi-kernel`. `src/api/`, `src/mcp/`, `src/ui/`, `src/integrations/` should import only from `@worklab-ai/agent-runtime` (no UI/API consumer pulls Pi-only helpers today — verify in commit and add an `ignorePatterns` exception if anything slips). Encode in `eslint.config.js`.

**Commit 2.4 — Move Pi-specific tests into `packages/pi-kernel/src/__tests__/`.**
- Move:
  - `packages/agent-runtime/src/__tests__/agent/pi-bridge.test.js` → `packages/pi-kernel/src/__tests__/pi-bridge.test.js`.
  - `packages/agent-runtime/src/__tests__/agent/tools.test.js` → `packages/pi-kernel/src/__tests__/tools.test.js`.
  - `packages/agent-runtime/src/__tests__/agent/compaction.test.js` → `packages/pi-kernel/src/__tests__/compaction.test.js`.
  - `src/__tests__/ai/pi-sdk.test.js` → `packages/pi-kernel/src/__tests__/sdk.test.js`.
  - `src/__tests__/agent/compaction.test.js` → merge into `packages/pi-kernel/src/__tests__/compaction.test.js` (or keep as a separate `compaction-host.test.js` if the host wiring is meaningfully different — verify on read).
- Update imports to use `@worklab-ai/pi-kernel` and `@worklab-ai/agent-runtime`.
- Tests that stay in agent-runtime: router, failure, cost, observer, registry, capabilities, file-change-stats, transcript, allowlists, approval, tool-bloat, backend, model-refs, runtime, runtime-brand, execution-mode-compat.
- Tests that stay in worklab-side `src/__tests__/`: `ai/cost.test.js` (calls cross-package), `ai/cli-providers.test.js`, `ai/codex-app.test.js`, `e2e/multi-sdk.test.js`.

### Phase 3 — Polish (1 commit)

**Commit 3.1 — Documentation.**
- New `packages/agent-runtime/README.md` section: "Provider registration model" — explains the registry and how external packages plug in (links to pi-kernel as the canonical example).
- New `packages/pi-kernel/README.md`: scope, why it exists separately, registration call required.
- Update root `CLAUDE.md` module-boundaries section: `packages/agent-runtime/` description shrinks (no Pi), add `packages/pi-kernel/` paragraph.
- Update `AGENTS.md` / `CONTRIBUTING.md` if they reference the old paths.
- Remove the stale `project_pi_sdk_runtime` memory once the routing comment lives in code (note: leave to the user post-merge — the memory is currently accurate, just describes the pre-split layout).

### Phase 4 — Verify worklab is healthy end-to-end (no commit, gated approval)

This phase produces no code changes — its purpose is to confirm the refactor didn't regress real worklab behavior before we declare the work done. **Do not merge the Phase 1-3 PR until every check below passes and the user has signed off on the results.** Capture findings in a checklist appended to the PR description.

**4.1 — Static checks.**
```bash
npm run lint                           # boundary rules pass at new paths
./scripts/guard-imports.sh             # banned-import sweep (db.prepare in api/, etc.)
./scripts/guard-banned-tokens.sh       # UI design-token rules (no UI changes expected, but confirm clean)
node scripts/guard-file-size.js        # file-size guardrails (if any file ballooned in the rename)
```
Every script returns 0. If `lint:boundaries` (warn-only) surfaces new warnings about cross-package imports, treat each as a real finding.

**4.2 — Full test suite.**
```bash
npm test                               # vitest across agent-runtime, pi-kernel, and worklab src
npm run test:coverage                  # confirm 60% thresholds still hold (excludes src/ui)
```
Specifically inspect the output to confirm:
- `packages/pi-kernel/src/__tests__/` tests ran (registry test, sdk test, compaction, pi-bridge, tools).
- `packages/agent-runtime/src/__tests__/runtime-registry.test.js` ran, including the negative case proving `unsupported sdk: pi` when pi-kernel isn't registered.
- No tests were silently skipped because of a broken import path.

**4.3 — UI build.**
```bash
npm run build:ui
```
Vite's bundler must resolve every UI import to `@worklab-ai/agent-runtime` cleanly (no `@worklab-ai/pi-kernel` should appear in the UI bundle — pi-kernel is Node-only). Inspect `src/ui/dist/` for the absence of `pi-` source paths.

**4.4 — End-to-end worklab smoke (manual, in a scratch data dir).**
```bash
WORKLAB_DATA_DIR=/tmp/worklab-refactor-smoke worklab serve --port 9091
```
With the service running, walk through these flows in a browser at `localhost:9091`:

1. **First boot.** Confirm `data-template/` was seeded into the scratch dir (agents, default project, etc.) and the UI loads without console errors.
2. **Pi-SDK happy path.** Create a small task for a Pi-SDK agent (e.g. a `worklab.v2`-shaped fixture). Watch the run complete in the UI: tool calls render, structured result lands, `task_runs.kind = 'agent_turn'` finishes cleanly. This proves `registerPiBridges()` ran, the registry resolves `pi`, compaction is wired, MCP tools work, approval gate works.
3. **Pi-CLI (codex-app) routing.** Same agent flipped to `executionMode: "cli"`. Confirm the run dispatches to the codex-app bridge (which lives in agent-runtime, not pi-kernel) and that compaction is NOT invoked for this path. This is the key proof that the split didn't accidentally couple Pi-CLI to pi-kernel.
4. **Claude-SDK path.** Create or reuse a Claude-SDK agent (no Pi involved). Run a task; confirm no `@worklab-ai/pi-kernel` modules load during the run. Grep `node --experimental-vm-modules ...` or attach a one-shot `NODE_DEBUG=module` to a worker invocation to verify.
5. **Claude-CLI path.** Same, with `executionMode: "cli"`. Confirm subprocess spawns and produces output.
6. **Codex CLI path.** Run a Codex agent task to confirm codex-app stayed functional through the file moves.
7. **Failure / recovery.** Trigger a retryable provider failure (mid-run kill of the worker, or use a fixture that injects a `rate_limited` error). Confirm `task_runs.parent_relationship = 'recovery_continuation'`, transcript-tail snapshot is rebuilt, the continuation runs. This proves `transcript.js` still works from its new `shared/` home.
8. **Shutdown drain.** With a long-running task in flight, `worklab stop`. Confirm `cancelled_shutdown` is emitted (not `cancelled_stale`) and the resume snapshot is persisted. On the next boot, a `coordinator_resume` continuation should pick up — verify it scheduled.
9. **Team lead cycle.** Trigger a team lead cycle (`POST /api/teams/:id/run-lead` or via the synthetic root). Confirm `lead_cycle` runs and produces task creations + advisory notes. The lead-cycle path lives entirely in worklab-side code but it consumes the runtime through the same `createRuntime` factory we just refactored — this is the broadest integration check.
10. **MCP admin + agent tools.** Hit the admin MCP endpoint (token-protected) and confirm a couple of read endpoints (`tasks/list`, `agents/list`) work. Confirm the stdio agent MCP bridge still launches via `worklab mcp`.
11. **Doctor.** Run `worklab doctor` and confirm it finds ripgrep (it imports `resolveRgPath` from the new `shared/` location).

**4.5 — Negative confirmation.**
- Temporarily comment out the `registerPiBridges()` call in `src/core/ai.js`. Spawn a Pi-SDK fixture task. The worker MUST exit with `unsupported sdk: pi` propagated as a structured failure (not a silent hang). Restore the call.
- Temporarily make `@worklab-ai/agent-runtime` import something from `@worklab-ai/pi-kernel` (e.g. add a stray import to `registry.js`). ESLint MUST fail with the boundary rule. Revert.

**4.6 — Playwright (if any UI behavior could regress).**
```bash
npm run test:e2e:ollama
```
Run only if a UI consumer was touched. The current refactor only updates UI imports for `executionModeIncompatibilityReason`, `claudeModelSupportsOneMillionContext`, `normalizeContextWindow`, `codexModelSupportsFastMode`, `normalizeFastMode`, `normalizeCodexItemEvent`, `normalizeCodexItemType` — pure-JS helpers. Playwright should be green without code intervention; if it isn't, the import path update is wrong.

**4.7 — Pack & install dry-run.**
```bash
npm run pack:check
```
Confirms both `@worklab-ai/agent-runtime` and `@worklab-ai/pi-kernel` produce installable tarballs with the expected file lists (the `files` field in pi-kernel's package.json must explicitly include `src/**/*.js`).

**4.8 — Sign-off checklist (paste into PR description).**
- [ ] Lint, guard scripts, full vitest, coverage thresholds, build:ui all green
- [ ] Pi-SDK fixture run completes (manual)
- [ ] Pi-CLI fixture run completes via codex-app, no pi-kernel imports loaded
- [ ] Claude-SDK and Claude-CLI fixture runs complete with no pi-kernel imports loaded
- [ ] Codex fixture run completes
- [ ] Retryable failure + recovery continuation works (transcript snapshot survives move)
- [ ] Shutdown drain + coordinator_resume continuation works
- [ ] Team lead cycle completes
- [ ] Admin MCP + agent MCP smoke green
- [ ] `worklab doctor` clean
- [ ] Negative test: missing `registerPiBridges()` produces a structured `unsupported sdk: pi` failure
- [ ] Negative test: agent-runtime importing pi-kernel fails lint
- [ ] `npm run pack:check` produces valid tarballs for both packages

---

## Critical files

**Created:**
- `packages/pi-kernel/package.json`
- `packages/pi-kernel/README.md`
- `packages/pi-kernel/src/index.js`
- `packages/agent-runtime/src/shared/mcp-helpers.js` (extracts `normalizeMcpToolParams`)

**Moved (git mv):** Listed inline above. Per-file destinations:

| Source | Destination |
|---|---|
| `packages/agent-runtime/src/agent/approval.js` | `packages/agent-runtime/src/shared/approval.js` |
| `packages/agent-runtime/src/agent/tool-bloat.js` | `packages/agent-runtime/src/shared/tool-bloat.js` |
| `packages/agent-runtime/src/agent/transcript.js` | `packages/agent-runtime/src/shared/transcript.js` |
| `packages/agent-runtime/src/agent/allowlists.js` | `packages/agent-runtime/src/shared/allowlists.js` |
| `packages/agent-runtime/src/agent/prompt/skill-index.js` | `packages/agent-runtime/src/shared/skill-index.js` |
| `packages/agent-runtime/src/agent/tools/shared/runtime-context.js` | `packages/agent-runtime/src/shared/runtime-context.js` |
| `packages/agent-runtime/src/agent/tools/shared/ripgrep.js` | `packages/agent-runtime/src/shared/ripgrep.js` |
| `packages/agent-runtime/src/ai/{backend,cost,failure,observer,file-change-stats}.js` | `packages/agent-runtime/src/shared/` |
| `packages/agent-runtime/src/ai/runtime/*` | `packages/agent-runtime/src/runtime/*` |
| `packages/agent-runtime/src/ai/providers/{claude-sdk,claude-cli,codex-app,claude-subagents}.js` | `packages/agent-runtime/src/providers/` |
| `packages/agent-runtime/src/ai/streaming/codex-events.js` | `packages/agent-runtime/src/streaming/codex-events.js` |
| `packages/agent-runtime/src/ai/providers/pi-{sdk,models,messages,events}.js` | `packages/pi-kernel/src/{sdk,models,messages,events}.js` |
| `packages/agent-runtime/src/ai/live-input-prompt.js` | `packages/pi-kernel/src/live-input-prompt.js` |
| `packages/agent-runtime/src/agent/compaction.js` | `packages/pi-kernel/src/compaction.js` |
| `packages/agent-runtime/src/agent/tools/**` | `packages/pi-kernel/src/tools/**` |

**Edited (imports updated):**
- `packages/agent-runtime/src/runtime.js` (line 25 import, doc comment lines 9–12)
- `packages/agent-runtime/src/runtime/registry.js` (remove `pi` spec, add `registerBridge`)
- `packages/agent-runtime/src/index.js` (rewrite barrel)
- `packages/agent-runtime/package.json` (exports field)
- `packages/agent-runtime/eslint.config.js` and root `eslint.config.js`
- `package.json` (add `@worklab-ai/pi-kernel` dep, possibly drop direct `@earendil-works/pi-ai` if no longer used in `src/`)

**Worklab-side import updates** (all 24 sites — repoint by named export):
- `src/worker.js:7`
- `src/coordinator/spawn-worker.js:16,42`
- `src/coordinator/watcher/stale-runs.js`
- `src/coordinator/watcher/recovery-continuation.js`
- `src/core/ai.js:2–10` (and add `registerPiBridges()` call)
- `src/core/settings.js`
- `src/core/execenv.js`
- `src/core/custom-pricing.js`
- `src/core/db/migrations/runner.js`
- `src/core/skills.js`
- `src/core/run-input.js:11,35`
- `src/core/run-artifacts.js`
- `src/core/artifact-collection.js`
- `src/core/live-input.js` → switches to `@worklab-ai/pi-kernel`
- `src/worker/automation-runner.js` → `@worklab-ai/pi-kernel`
- `src/worker/consolidate-runner.js` → `@worklab-ai/pi-kernel`
- `src/worker/agent-turn.js` → `@worklab-ai/pi-kernel`
- `src/api/routes/skills.js`
- `src/api/routes/agents.js`
- `src/mcp/agent/tools/agents.js`
- `src/cli/doctor.js` — `configureToolRuntime` + `resolveRgPath` both from agent-runtime root barrel
- `src/ui/src/routes/AgentEdit.jsx`
- `src/ui/src/components/EventTimeline.jsx`
- `src/ui/src/components/primitives/ToolToken.jsx`
- `examples/echo-agent/index.js`
- All worklab `src/__tests__/` files listed in the test plan above.

---

## Existing utilities to reuse (not reinvent)

- `createObserverHub` already merges host- and call-level observers cleanly (`agent-runtime/src/ai/observer.js`) — no change needed beyond move.
- `resolveRuntimeBrand` already handles brand defaulting (`agent-runtime/src/runtime-brand.js`) — stays put.
- `createApprovalManager` + `wrapToolsWithApprovalGate` (`agent/approval.js`) is the shared approval surface; pi-kernel imports it from agent-runtime rather than re-implementing.
- `summarisePayload` / `wrapToolsWithBloatGuard` from `agent/tool-bloat.js` — same: stays in agent-runtime, pi-kernel imports.
- `failureKindForPiError` lives in `ai/failure.js` today. Even though the name says "Pi", the function dispatches on error shape and is the canonical taxonomy entry point. Keep in agent-runtime's `shared/failure.js`; pi-kernel calls it.
- `normalizeMcpToolParams` (currently inside `agent/tools/pi-bridge.js`) is provider-agnostic — that's why Claude SDK already imports it. Extract to `shared/mcp-helpers.js`. Do NOT leave it in pi-bridge once pi-bridge moves.

---

## Verification

Run after Phase 1 (each commit) and Phase 2 (each commit):

```bash
npm run lint                           # boundary rules pass at new paths
./scripts/guard-imports.sh             # banned imports
npm test                               # full vitest suite
npm run build:ui                       # UI imports resolve (Vite bundler)
```

Run after Phase 2 completes:

```bash
npm run test:e2e:ollama                # cross-provider e2e on a real UI build
worklab serve                          # smoke: boot service, hit UI
```

End-to-end smoke checks once `worklab serve` is up:
1. **Pi-SDK path**: create an agent with `sdk: "pi"`, run a small task, confirm the worker spawns, compaction triggers if context is large, structured `worklab_result` is returned. Asserts `registerPiBridges()` ran and the registry resolves `pi`.
2. **Pi-CLI path**: same agent with `executionMode: "cli"`, confirm it routes through the codex-app bridge (which lives in agent-runtime, not pi-kernel — proves the split didn't break the CLI route).
3. **Claude SDK path**: confirm a Claude agent runs without touching anything in pi-kernel (run with `NODE_OPTIONS=--require=<no-pi>` if needed — better, just confirm by grep that the import graph for a Claude run never reaches `@worklab-ai/pi-kernel`).
4. **Negative test**: temporarily comment out the `registerPiBridges()` call in `src/core/ai.js`, run the Pi-SDK fixture task, confirm it fails with `unsupported sdk: pi`. Restore the call.
5. **MCP admin tools**: hit `/api/agents` (uses model-refs, allowlists from agent-runtime), `/api/skills` (uses allowlists), confirm responses are unchanged.

Add new unit tests for the registry split:
- `packages/agent-runtime/src/__tests__/runtime-registry.test.js`: `registerBridge` adds a spec, `resolveRuntimeBridge` picks it, registration order matters, duplicate `id` replaces (with warning).
- `packages/pi-kernel/src/__tests__/registration.test.js`: `registerPiBridges()` registers the `pi` spec; calling it twice is idempotent; after registration, a fake `{ sdk: "pi" }` ref resolves to the Pi bridge.

---

## Open risks and concerns

1. **Circular dep avoidance.** pi-kernel depends on agent-runtime (for `registerBridge`, `createApprovalManager`, `summarisePayload`, etc.). agent-runtime MUST NOT depend on pi-kernel — encode in ESLint and in CI by failing if `packages/agent-runtime/**` imports `@worklab-ai/pi-kernel`.
2. **`@earendil-works/pi-ai` in root `package.json`.** Verify nothing in `src/` outside the runtime workspace imports it. If so, drop it from root deps during commit 2.2.
3. **`runtime.js` comment drift.** Lines 9–12 currently claim "all four built-in bridges register themselves on import" — that becomes false after Phase 2. Rewrite carefully so it reads correctly post-split (three built-in, Pi external).
4. **The temporary "Pi-bay" inside agent-runtime between Phase 1 and Phase 2.** After commit 1.2, `pi-sdk.js`, `pi-models.js`, `pi-messages.js`, `pi-events.js`, `agent/compaction.js`, and `agent/tools/**` are sitting inside `agent-runtime` waiting to be lifted out. The tree compiles and tests pass at this point — but if someone merges Phase 1 without Phase 2, the structure is uglier than it started. **Land Phase 1 + Phase 2 + Phase 3 in the same PR or back-to-back PRs**; don't ship Phase 1 alone.
5. **`structured-output.js` location.** This tool exists because Pi needs a way to surface the final structured payload through tool calls. It's Pi-only — moves to pi-kernel with the rest of tools. Verify no other provider references it before moving.
6. **Test that imports a Pi-internal path.** `packages/agent-runtime/src/__tests__/agent/pi-bridge.test.js` currently reaches into `src/agent/tools/pi-bridge.js` directly. After the move, it imports from `@worklab-ai/pi-kernel`. Make sure the test continues to exercise the same internals — if it relied on a non-exported symbol, expose it through pi-kernel's barrel or add a `__test__` export.
7. **Doctor command.** `src/cli/doctor.js` currently imports `resolveRgPath` from `agent-runtime/agent/tools/index.js`. After the split, ripgrep resolution lives in `agent-runtime/shared/ripgrep.js` and is re-exported from the root barrel. Confirm the doctor still works (it checks for ripgrep availability) — minor import update only.
8. **Sequence of `registerPiBridges()` vs `createRuntime` call.** Worklab's `src/core/ai.js` exports a memoized `createRouterRuntime` that's awaited by `coordinator.js` and `worker.js`. Registration must run before the first `createRuntime` consumer touches `resolveRuntimeBridge`. The simplest safe place is module-top in `src/core/ai.js` — that file is imported eagerly by the coordinator and worker entry points. Add an integration test that imports `src/core/ai.js` fresh and immediately resolves a `pi` ref.
