# Getting Started

A guide to installing worklab, creating your first agents, and running your first task.

---

## Prerequisites

- **Node.js 20+** (check with `node --version`)
- **macOS or Linux** (Windows is not supported in v1)
- **One AI provider credential** — choose one:
  - `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` — Claude Agent SDK (recommended for first use)
  - `OPENAI_API_KEY` — OpenAI Agents SDK
  - A running [Ollama](https://ollama.ai) install — Vercel AI path for offline models

---

## Install

```bash
git clone <repo-url> worklab
cd worklab
npm install
npm start
```

The server starts on **http://localhost:7878** by default.

`npm start` builds the Preact frontend into `src/ui/dist/` before launching the
coordinator. Use `node src/cli/index.js start` only when the frontend has already
been built.

---

## First Boot

On first start, if `data/` is empty, worklab seeds it from `data-template/`:

- `data/agents/`, `data/skills/`, `data/knowledge/` directories are created.
- A `.provider-encryption-key` file is auto-generated at `data/.provider-encryption-key`
  (permissions 0600) unless `PROVIDER_ENCRYPTION_KEY` is set in the environment.
- The SQLite database `data/worklab.db` is initialized with WAL mode.

Open **http://localhost:7878** in your browser. You should see the worklab UI.

---

## First Agent

Navigate to **Agents → Create** and fill in the form:

| Field | Value |
|-------|-------|
| Name | `coder` (internal identifier, lowercase, no spaces) |
| Display name | `Coder` |
| Instructions | `You write clean, well-tested code.` |
| SDK | `claude` |
| Model | `sonnet` |
| Effort | `medium` |

Save. The agent appears in the agent list.

---

## First Reviewer

Create a second agent with these values:

| Field | Value |
|-------|-------|
| Name | `reviewer` |
| Display name | `Reviewer` |
| Instructions | `Review the executor's work against the task instructions. Respond with a final message whose first line is either VERDICT: APPROVE or VERDICT: REJECT. If REJECT, follow with bullet-pointed notes the executor can act on.` |
| SDK | `claude` |
| Model | `sonnet` |
| Effort | `medium` |

The exact `VERDICT: APPROVE` / `VERDICT: REJECT` prefix on the first non-blank
line is required — worklab parses it literally (see `src/core/review.js`).

---

## First Task

Navigate to **Tasks → + New** and fill in:

| Field | Value |
|-------|-------|
| Title | `Hello worklab` |
| Description | `Greeting task` |
| Instructions | `Say hi and write a haiku about software.` |
| Executor | `coder` |
| Reviewer | `reviewer` |

Save, then click **Run now**.

---

## What to Expect

The task detail page shows an **EventTimeline** that streams SDK events live:
thinking steps, tool calls, and text output appear as the agent works.

Task status transitions:

```
todo → in_progress → in_review → done        (if APPROVE)
                   → in_progress             (if REJECT — executor retries with notes)
```

When the run finishes you will see:
- An **agent comment** with the executor's final text.
- A **system verdict comment** (`VERDICT: APPROVE` or `VERDICT: REJECT` with notes).

---

## First Knowledge Base Entry

Navigate to **Knowledge → + New**:

| Field | Value |
|-------|-------|
| Slug | `coding-style` |
| Title | `Coding style guide` |
| Body | `Always prefer const. Use descriptive names.` |
| Tags | `coding` |
| Pinned | checked |

Save. Pinned entries are injected into every agent's system prompt automatically
(up to the `kb_pinned_limit` setting, default 10).

Re-run the `Hello worklab` task — the KB entry appears inlined in the context
the executor receives.

---

## Next Steps

- **`docs/configuration.md`** — environment variables, settings table, data directory layout
- **`docs/cli.md`** — all CLI commands and typical lifecycle patterns
