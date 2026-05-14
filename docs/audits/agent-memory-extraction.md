# Agent-Memory Extraction Audit

_Status: 2026-05-14 — analysis only, no extraction performed._

This audit zooms in on the agent-memory subsystem the packaging audit lumped under `@worklab-ai/agent-tools`, separates it into three tiers, and answers two specific questions the user raised:

1. What is the *universal, reusable* public interface a non-Worklab caller should get?
2. How would a new project combine an agent's journal entries into long-term memory?

The audit's scope is "what would extraction look like and what blocks it." Each tier names its scope, public surface, blockers, and what reuse it unlocks.

## 1. Today's three layers

"Agent memory" in Worklab is actually three mental models stitched together:

| Layer | File | LOC | Storage | Who calls it |
|---|---|---|---|---|
| **A — Plain-file journal/memory** | `src/core/journal.js` | 106 | Filesystem (`<dataDir>/agents/<agent>/{JOURNAL,MEMORY}.md`) | MCP tools (`journal_append`, `journal_summary`), worker runners, consolidation worker |
| A (read side) | `src/core/memory.js` | 66 | Filesystem | API routes (`routes-agents.test.js` confirms), consolidation reader |
| **B — Structured memory store** | `src/core/agent-learning.js` | 528 | SQLite `agent_memories` table | Task watcher (`task-watcher.js:14`), MCP `memory_*` tools, API `routes-agent-memories.js` |
| B (consolidation rows) | `src/core/db/queries/agent-consolidations.js` | — | SQLite `agent_consolidations` table | `memory.js`, `consolidation-cron.js` |
| **C — Consolidation orchestration** | `src/coordinator/consolidation-cron.js` (160) + `src/worker/consolidate-runner.js` (90) | 250 | Spawns workers, hashes files, writes DB | Coordinator startup |
| MCP bridge | `src/mcp/agent/tools/memory.js` | 148 | Both | Worker agent runs |
| Schema | `src/core/db/schema/current.js:413` (`agent_consolidations`), `:420` (`agent_memories`) | — | — | Migrations |

Tests: 548 LOC across `src/__tests__/core/{journal,memory,agent-learning,agent-learning-run-input}.test.js`.

**Layer A** is the agent's own self-edited memory — append-only JOURNAL.md plus a periodically rewritten MEMORY.md. The agent's perspective: I write notes; the system periodically summarizes them.

**Layer B** is the *system's* memory of the agent — structured candidates with kind, scope, confidence, status. Surfaces in the UI as reviewable "memories" with promotion/archival workflows. The agent doesn't author rows directly; the consolidator + run-result handler proposes them.

**Layer C** is the *trigger* that turns layer A into a new MEMORY.md every so often. Cron + spawn + LLM call.

The three are independent enough that they can extract on independent timelines.

## 2. Tier A — `@worklab-ai/agent-journal` (S effort, recommended first)

**Scope:** `src/core/journal.js` + the pure file-read helpers from `src/core/memory.js` (everything except the `getAgentConsolidation` DB call, which stays in Worklab).

**Caller contract:** pass `dataDir` (any absolute path the caller owns). That is the only requirement. No DB, no schema, no env-var lookup, no global state, no default of `~/.worklab`.

**Blockers:** none. `journal.js` already takes `dataDir` as a parameter on every public function. The split inside `memory.js` is mechanical: lift the file-read functions out, leave the consolidation lookup in core.

**Unlocks:** any agent runtime can persist per-agent JOURNAL.md / MEMORY.md without adopting SQLite or any other Worklab concept. Direct fit for the proposed `@worklab-ai/webhook-agent` (U2) and `@worklab-ai/team-orchestrator` (U1) packages.

### 2.1 Universal public interface — design rules

The package must follow these rules so it stays reusable in any Node project. For each rule, the current Worklab code is graded on whether it already complies.

| Rule | Compliance today | Action |
|---|---|---|
| No environment-variable reads inside the package | ✅ `journal.js` reads no env vars; caller passes `dataDir` | Keep as-is |
| No filesystem defaults; layout is configurable | ⚠️ Layout (`<dataDir>/agents/<agent>/{JOURNAL,MEMORY}.md`) is hardcoded inside `agentJournalPath()` and `agentMemoryPath()` | Optional: add a `pathStrategy` argument with the current behavior as default. Skippable for v1. |
| No logger import inside the package | ✅ `journal.js` does no logging | Keep as-is |
| Missing files return `{ exists: false, content: "" }` instead of throwing | ✅ `readFileIfExists()` in `memory.js` already does this | Keep as-is |
| JSON-serializable inputs and outputs | ✅ Hash is hex string, content is string, paths are strings | Keep as-is |
| Pure functions; no event emitters or globals | ✅ All functions take their inputs as arguments and return values | Keep as-is |
| No mutation of caller-provided arguments | ✅ Arguments are read but not mutated | Keep as-is |
| No dependency on `@worklab-ai/agent-runtime` or any other Worklab package | ✅ Only depends on `node:fs`, `node:path`, `node:crypto` | Keep as-is |

**The current code is already 7/8 compliant** — only the filesystem-layout flexibility is missing, and even that is a v2 nice-to-have, not a blocker.

### 2.2 Concrete public surface

Exact names and signatures the package will expose:

```js
// Path helpers (pure)
agentJournalPath(dataDir, agent) → string
agentMemoryPath(dataDir, agent) → string

// Journal (append-only)
appendJournalEntry({ dataDir, agent, runId, taskId?, taskTitle?, bullet, now? }) → string  // absolute path written
appendJournalSummary({ dataDir, agent, runId, text, now? }) → string
readJournalTail({ dataDir, agent, maxLines? }) → { content: string, lines: number }
readFullJournal({ dataDir, agent }) → string

// Memory (overwrite-only)
writeMemory({ dataDir, agent, content }) → string
readAgentMemoryContent({ dataDir, agent }) → string  // "" if missing
agentJournalHash({ dataDir, agent }) → string | null  // sha256 of JOURNAL.md

// Consolidation helper (see §3 below)
consolidateJournalToMemory({ dataDir, agent, generate, promptTemplate?, onUnchanged? }) → Promise<{ memory: string, path: string, journalHash: string }>
```

### 2.3 Using this outside Worklab — minimal example

```js
import {
  appendJournalEntry,
  readJournalTail,
  consolidateJournalToMemory,
} from "@worklab-ai/agent-journal";
import OpenAI from "openai";

const dataDir = "/var/lib/my-bot";  // caller owns this path
const agent = "support-bot";

// As the agent works, append observations:
appendJournalEntry({ dataDir, agent, runId: "run-abc", bullet: "User asked about refunds; pointed them to policy doc X." });

// Later, when the journal has accumulated enough entries, consolidate:
const client = new OpenAI();
const generate = async (systemPrompt, userMessage) => {
  const r = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
  });
  return r.choices[0].message.content;
};

const { memory, journalHash } = await consolidateJournalToMemory({ dataDir, agent, generate });
console.log("New MEMORY.md written, hash:", journalHash);
```

No SQLite, no env vars, no other Worklab assumptions. The whole state is two markdown files on disk plus a hash the caller can persist however they want (a JSON file, Redis, Postgres, anything).

## 3. Journal → long-term memory: how consolidation actually works

This is the non-obvious half of "agent memory" and the second question the user raised. The flow Worklab uses today (verified by reading `src/worker/consolidate-runner.js` and `src/coordinator/consolidation-cron.js`):

1. **Trigger.** The coordinator's `consolidation-cron.js` ticks every 60 s. If `consolidation_enabled` is true and the current local hour matches `consolidation_hour`, it iterates the enabled agents. For each, it hashes JOURNAL.md and compares against the last consolidation's stored hash (`agent_consolidations` table). If unchanged, skip. If changed, proceed.

2. **Spawn.** `runNow(agentName)` inserts a `task_runs` row with `mode = 'consolidate'` and forks a worker with `--mode consolidate --agent <name>`.

3. **Worker setup.** `runConsolidate(ctx)` in `src/worker/consolidate-runner.js`:
   - `readAgentMemoryContent({ dataDir, agent })` — current MEMORY.md
   - `readFullJournal({ dataDir, agent })` — entire JOURNAL.md
   - If the journal is empty (`.trim()` empty), abort with "no journal entries to consolidate."
   - Builds the system prompt via `buildConsolidationSystemPrompt({ agent, memory, journal })` (`src/core/prompts/system-prompt.js`). This delegates to `buildSystemPrompt(input, "consolidate")` — same 737-LOC builder used for task runs, just with a "consolidate" mode flag that selects a different section blend.

4. **LLM call.** `generateResponse(systemPrompt, { messages: [{ role: "user", content: "Consolidate this agent's journal into MEMORY.md." }], allowedTools: [], disallowedTools: ["journal_append", "journal_summary"], ... })` — **the LLM is the consolidator.** It has no tools available; it just reads the prompt and emits text. The user message is literally the one-line instruction quoted above.

5. **Write-back.** `writeMemory({ dataDir, agent, content: result.text })` overwrites MEMORY.md with the LLM's output. The previous MEMORY.md content is gone (the LLM was given it as input and presumably preserved what mattered).

6. **Bookkeeping.** `upsertAgentConsolidation()` records the new journal hash + timestamp. Optionally `indexPath()` rebuilds full-text search for the new MEMORY.md.

**The takeaway: consolidation is LLM-driven, not deterministic.** The new MEMORY.md is the model's distillation of (old MEMORY.md + full JOURNAL.md). There is no rules engine, no template, no diffing — just a system prompt that says "consolidate" and the model figures it out.

### 3.1 How a new project replicates this

A non-Worklab project needs four things, three of which the package supplies:

| Need | Provided by | Notes |
|---|---|---|
| Read/write JOURNAL.md and MEMORY.md | Tier A package (§2) | — |
| A way to call an LLM | Caller-provided | Pass `generate: async (systemPrompt, userMessage) => string`. Caller picks OpenAI, Anthropic, Ollama, local, etc. The package never imports an LLM SDK. |
| A consolidation prompt | Package default + override | Default: a generic "you are consolidating an agent's journal..." prompt. Override via `promptTemplate` argument. Worklab's own prompt (in `buildSystemPrompt(..., "consolidate")`) is tangled with Worklab-specific affordances and is NOT a good general-purpose default; the package ships its own clean version. |
| A trigger | Caller-provided | Three reasonable patterns — see §3.2. |

### 3.2 Three trigger patterns a new project can pick

- **Hash-change detection** (Worklab's choice). Hash JOURNAL.md; if it differs from the last consolidation's stored hash, run. The package exposes `agentJournalHash({ dataDir, agent })`. The caller stores the previous hash wherever it likes (JSON file, Redis, Postgres). Cheapest, only-when-needed.
- **Size-bound.** Run when JOURNAL.md exceeds N bytes. Caller computes `statSync(path).size`. Useful for hot agents where the journal grows fast.
- **Time-bound.** Daily cron, every-N-runs, etc. Caller provides the scheduler (node-cron, cloud scheduler, etc.). The package never owns scheduling.

The package's `consolidateJournalToMemory()` is idempotent and side-effect-only-on-write — calling it twice in a row with no new journal entries is safe (no change to MEMORY.md).

### 3.3 What stays in Worklab (NOT in the package)

- `consolidation-cron.js` — Worklab-specific. It uses the broker for SSE events, the spawn pipeline for workers, the settings DB for cron config, and the `agent_consolidations` table for hash bookkeeping. None of these are universal primitives.
- `agent_consolidations` table — useful pattern, but persistence strategy is a caller decision. The package returns the new hash; callers persist however they want.
- `indexPath()` full-text reindex — Worklab feature, not memory-related.

## 4. Tier B — `@worklab-ai/agent-memory-store` (M effort, after a cleanup pass)

**Scope:** `src/core/agent-learning.js` + `src/core/db/queries/agent-consolidations.js` + the two table DDLs from `src/core/db/schema/current.js:413` and `:420`.

**Public surface (provisional):** `AGENT_MEMORY_KINDS`, `AGENT_MEMORY_SCOPES`, `AGENT_MEMORY_STATUSES`, `MAX_AGENT_MEMORY_CANDIDATES_PER_BATCH`, `recordAgentMemoryCandidates`, `recordRunResultLearning`, `getAgentConsolidation`, `upsertAgentConsolidation`, `memoryContentKey`.

**Caller contract:** caller provides a `better-sqlite3` DB handle. The package exports the DDL strings and (optionally) a `migrate(db)` function that runs them. Caller decides when migrations run.

**Quality blocker (recommended, not lint-required):** `src/core/agent-learning.js` has 12 inline `db.prepare(...)` call sites (verified: `grep -c 'db.prepare' src/core/agent-learning.js` returns 12). The project's ESLint `FORBID_API_DB_PREPARE` rule (`eslint.config.js:99..108`) currently forbids `db.prepare` **only inside `src/api/**`**, not in `src/core/**`, so this is allowed today. But for clean extraction, every SQL statement should live in a single `src/core/db/queries/agent-memories.js` module before the package is published — otherwise the extracted package would have SQL embedded in business logic, which makes future schema changes harder. This refactor is internal to Worklab and orthogonal to the extraction itself.

**Unlocks:** structured memory candidates with kind/scope/confidence as a reusable primitive. Useful for agent systems that want a curated long-term memory beyond raw journal/MEMORY.md text. Worth doing only if some downstream consumer actually wants this — for the U1/U2 use cases in the packaging audit, tier A alone is probably enough.

## 5. Tier C — consolidation orchestration (L effort, defer)

Scope: `src/coordinator/consolidation-cron.js` + `src/worker/consolidate-runner.js`.

Tightly coupled to Worklab's coordinator: spawn pipeline, broker, DB-singleton, settings table. Same blockers as the deferred `@worklab-ai/orchestrator` package in `docs/audits/packaging-audit.md`. Don't tackle until the broader coordinator extraction is on the table.

**Important:** the *primitive* this tier wraps — "use an LLM to turn JOURNAL.md into a new MEMORY.md" — is already provided by tier A's `consolidateJournalToMemory()`. Tier C only adds the scheduling and process-spawning glue. A non-Worklab project doesn't need tier C; it can call `consolidateJournalToMemory()` from any scheduler it already has.

## 6. MCP tools split

Today `src/mcp/agent/tools/memory.js` mixes journal tools and memory-store tools:

| Tool | Belongs with |
|---|---|
| `journal_append` | Tier A |
| `journal_summary` | Tier A |
| `journal_search` | Tier A (search is journal text search) |
| `memory_read` | Tier A (reads MEMORY.md; layer A territory) |
| `memory_search` | Tier B (searches the structured `agent_memories` table) |
| `run_log_read` | Out of scope here — belongs with a future "run logs" primitive |

When tier A and tier B publish, the MCP tool definitions split along these lines.

## 7. Migration / dogfood plan

The audit doesn't prescribe execution, but a sensible order for follow-up planning:

1. **Phase 1 (optional cleanup):** Move the 12 inline `db.prepare` calls out of `src/core/agent-learning.js` into a new `src/core/db/queries/agent-memories.js`. Pure refactor, no behavior change. Only required if/when tier B publishes; tier A doesn't need this.
2. **Phase 2 (tier A):** Publish `@worklab-ai/agent-journal`. Either as a new sibling workspace package under `packages/agent-journal/` or as a `./agent-journal` entry point on the existing `@worklab-ai/agent-runtime`. Includes `consolidateJournalToMemory()` with a generic default prompt. Worklab consumes it via workspace symlink. Tests stay where they are; just update imports.
3. **Phase 3 (tier B):** Publish `@worklab-ai/agent-memory-store` after Phase 1. Caller provides DB + runs the DDL.
4. **Phase 4 (deferred):** Reassess tier C alongside the coordinator extraction.

## 8. What this audit is not

- Not an execution plan for any tier. Each phase above needs its own planning pass.
- Not a commitment that all three tiers should ship. Tier A is the clear win; tier B is contingent on a downstream consumer; tier C is genuinely deferred.
- Not a redesign of the consolidation prompt. Worklab's existing prompt stays as-is for Worklab's own use; the package ships its own clean, generic version for non-Worklab consumers.

## 9. Cross-reference

This audit refines the packaging audit (`docs/audits/packaging-audit.md`) in one specific way: the line in that audit's package table that says `@worklab-ai/agent-tools` should bundle journal + memory + KB tools should be split — tier A and tier B above are independent extractions, not a single bundle. KB tools are outside this audit's scope.
