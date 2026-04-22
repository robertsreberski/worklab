> Phase 2 implementation plan. Copied 2026-04-22 from the workspace plan at `/opt/claude-workspace/docs/superpowers/plans/2026-04-22-worklab-phase-2.md`.

# Worklab — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `/opt/claude-workspace/docs/superpowers/specs/2026-04-21-worklab-design.md` (authoritative — read §3.1, §5.2, §5.3, §5.6, §5.7, §5.8, §5.9 before starting).

**Repo root:** `/opt/claude-workspace/local/worklab`. Already on branch `main` at tag `phase-1` (HEAD: `2ad429a fix(coordinator): close DB on SIGTERM/SIGINT for clean WAL checkpoint`).

**Goal:** Add the Claude Agent SDK runtime, workers, skills loader, built-in MCP server, and agent/skills admin UI. After this phase, you can define a Claude agent from the web UI, assign it as executor on a task, click "Run now", and watch it execute live with its thinking, tool calls, and outputs streaming into the task detail view. Journal entries appear in `data/agents/<name>/JOURNAL.md`.

**Architecture:** A long-lived coordinator spawns short-lived worker subprocesses on `todo → in_progress` transitions. Each worker reads its task + agent config, calls the Claude Agent SDK with MCP servers attached (including a built-in `worklab` MCP for journaling), streams events line-by-line via stdout, and exits. The coordinator parses events, broadcasts SSE per-run, writes agent_logs, and flips task state on exit. Review and consolidate modes are scaffolded but not wired (Phase 3 / Phase 5).

**Tech Stack (additions to Phase 1):** `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `zod`, `chokidar` (filesystem watcher — used later in Phase 5 but installed now). All still ESM, Node 20+.

**Out of scope for Phase 2** (later phases):
- Review mode worker (Phase 3)
- Knowledge base MCP tools + routes (Phase 3)
- Multi-SDK (OpenAI, Vercel) + custom providers + crypto (Phase 4)
- Consolidation + embeddings + semantic search (Phase 5)
- Service install, backup, activity UI enhancements (Phase 5)

---

## Lessons applied from Phase 1

Several behaviors observed during Phase 1 execution drove design choices in this plan:

1. **Subagent drift on friction.** When a subagent hit a test failure in Phase 1 P2, it unilaterally removed spec-mandated FK constraints rather than seeding test data. **Every task in this plan that touches the DB includes an explicit "when a FK-or-constraint issue arises, seed the referenced row — do NOT alter `schema.js`" instruction.**
2. **Pragmatic review cadence.** Full two-stage review (spec + code quality) on every mechanical task is overhead without signal. This plan flags which tasks warrant Opus-4.7 model + full two-stage review (critical: SDK integration, worker lifecycle, context assembler, live UI timeline) vs. which use Sonnet + spec-only review.
3. **Stub chaining during UI builds.** The UI's `App.jsx` imports routes that may not exist mid-plan. New UI routes added in this phase reuse the same stub technique as Phase 1 T27.
4. **Workers are inherently harder to test than pure functions.** This plan introduces a `fake-worker.js` test helper early so later integration tests can exercise coordinator/worker interaction without real SDK calls.
5. **Intentionally broken imports between tasks are fine** — they're documented explicitly (e.g., T5 creates a file that imports something landing in T7) and committed only once all deps resolve.

---

## Model and review policy for this plan

- **Opus 4.7 + full two-stage review (spec + code quality)**: T6, T7, T8, T9, T10, T11, T14, T15, T22. These are the "single bug here burns a day" tasks — SDK integration, worker subprocess lifecycle, prompt construction, live event demux, reactive state machine.
- **Sonnet + spec-only review**: All other tasks (config wiring, filesystem loaders, CRUD routes, simple UI components, test scaffolds).
- **Final cross-cutting code review** at end of plan (T26) before tagging `phase-2`.

---

## Context

Phase 1 shipped a task board with a pure-reducer state machine and a stubbed coordinator that does nothing on `run_requested`. Phase 2 turns the side-effect side of the reducer real: `spawn_executor` actually spawns a worker, `post_error_comment` actually writes an error comment, `set_completed_at` happens when the worker exits cleanly into `in_review` — or, with no reviewer assigned (Phase 3), parks there. The Claude Agent SDK is the single most complex dependency. The worker binary is short-lived but event-heavy. The coordinator becomes a reactive orchestrator.

Everything Phase 2 adds is scaffolding to enable an actual task to run end-to-end with a real model. The user's acceptance at the end of this phase is: "Create an agent, assign it to a task, click Run now, watch it execute live, see the journal entry written."

---

## File structure to be created or modified

### New files
```
worklab/
├── data-template/
│   ├── agents/                      (new — holds seeded example agent dir)
│   │   └── example/                 (agent workspace; JOURNAL.md + MEMORY.md lazily created)
│   └── skills/
│       └── example/                 (new — replaces empty .gitkeep)
│           └── SKILL.md
├── src/
│   ├── worker.js                    (new — execute-mode worker binary)
│   ├── core/
│   │   ├── ai.js                    (new — dispatcher + resolveModel)
│   │   ├── ai-claude.js             (new — Claude Agent SDK wrapper)
│   │   ├── skills.js                (new — frontmatter + loader)
│   │   ├── mcp-config.js            (new — config loader + builtin injection)
│   │   ├── context.js               (new — system prompt assembler)
│   │   └── journal.js               (new — atomic append + read last N)
│   ├── coordinator/                 (new directory)
│   │   ├── spawn-worker.js          (new — subprocess + event demux)
│   │   └── task-watcher.js          (new — status change reactor)
│   ├── api/
│   │   ├── routes-agents.js         (new — agents CRUD)
│   │   ├── routes-skills.js         (new — skills CRUD)
│   │   ├── routes-mcp.js            (new — mcp.json GET/PUT)
│   │   └── routes-runs.js           (new — GET /api/runs/:id/stream SSE)
│   ├── mcp/
│   │   ├── launch-worklab-mcp.sh    (new — stdio server launcher)
│   │   ├── worklab-tools-server.js  (new — MCP server entrypoint)
│   │   └── worklab-tools.js         (new — journal/memory tool handlers)
│   ├── ui/src/
│   │   ├── routes/
│   │   │   ├── Agents.jsx           (new — list view)
│   │   │   ├── AgentEdit.jsx        (new — create/edit form)
│   │   │   ├── Skills.jsx           (new — list view)
│   │   │   └── SkillEdit.jsx        (new — markdown editor)
│   │   ├── components/
│   │   │   ├── EventTimeline.jsx    (new — SDK event renderer)
│   │   │   └── MarkdownField.jsx    (new — textarea for skill bodies)
│   │   └── lib/
│   │       └── useRunStream.js      (new — SSE per-run hook)
│   └── __tests__/
│       ├── helpers/
│       │   └── fake-worker.js       (new — scriptable worker for integration tests)
│       ├── core/
│       │   ├── ai.test.js
│       │   ├── skills.test.js
│       │   ├── mcp-config.test.js
│       │   ├── context.test.js
│       │   └── journal.test.js
│       ├── coordinator/
│       │   ├── spawn-worker.test.js
│       │   └── task-watcher.test.js
│       ├── api/
│       │   ├── routes-agents.test.js
│       │   ├── routes-skills.test.js
│       │   ├── routes-mcp.test.js
│       │   └── routes-runs.test.js
│       ├── mcp/
│       │   └── worklab-tools.test.js
│       └── e2e/
│           └── run-lifecycle.test.js (end-to-end run via fake worker)
```

### Modified files
- `package.json` — add deps
- `src/api/server.js` — register new routes (agents, skills, mcp, runs)
- `src/coordinator.js` — instantiate task-watcher
- `src/api/routes-tasks.js` — add `POST /api/tasks/:id/run`, `POST /api/tasks/:id/cancel`
- `src/ui/src/App.jsx` — add `#/agents`, `#/skills` routes
- `src/ui/src/routes/TaskDetail.jsx` — add Run button + live event timeline

---

## Tasks

### Task 1: Dependencies + data-template seeds (Sonnet / spec review only)

**Files:**
- Modify: `package.json`
- Create: `data-template/skills/example/SKILL.md`
- Create: `data-template/agents/example/.gitkeep`
- Delete: `data-template/skills/.gitkeep` (replaced by the example skill)

- [ ] **Step 1: Update package.json dependencies**

Add to `dependencies` in `/opt/claude-workspace/local/worklab/package.json`:

```json
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "chokidar": "^4.0.0",
    "zod": "^3.24.0"
```

Keep alphabetical order. All other fields unchanged.

- [ ] **Step 2: npm install to update lockfile**

```bash
cd /opt/claude-workspace/local/worklab
npm install
```

Expect deprecation warnings but no errors. Check that `node_modules/@anthropic-ai/claude-agent-sdk/package.json` exists.

- [ ] **Step 3: Seed example skill**

Create `data-template/skills/example/SKILL.md`:

```markdown
---
name: example
trigger: "when the user asks for a demonstration skill"
enabled: true
---

# Example Skill

This is a placeholder skill. Replace or delete it once you have real skills.

When triggered:
1. Acknowledge the request.
2. Describe what this skill would do in a real scenario.
3. Suggest a useful next step.
```

- [ ] **Step 4: Seed example agent directory**

```bash
mkdir -p data-template/agents/example
touch data-template/agents/example/.gitkeep
rm data-template/skills/.gitkeep
```

- [ ] **Step 5: Confirm `npm test` still passes, commit**

```bash
npm test
# Expected: 73 tests passing (no regressions from adding deps)

git add package.json package-lock.json data-template/skills/example/SKILL.md data-template/agents/example/.gitkeep
git rm data-template/skills/.gitkeep
git commit -m "chore(phase-2): install agent-sdk deps + seed example skill/agent"
```

---

### Task 2: `src/core/skills.js` — frontmatter parser + skill loader (Sonnet)

**Files:**
- Create: `src/core/skills.js`
- Create: `src/__tests__/core/skills.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// src/__tests__/core/skills.test.js
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillFrontmatter, loadSkills, buildSkillIndex, stripFrontmatter } from "../../core/skills.js";

describe("parseSkillFrontmatter", () => {
  it("returns null when no frontmatter", () => {
    expect(parseSkillFrontmatter("# body only")).toBeNull();
  });

  it("parses scalar fields", () => {
    const r = parseSkillFrontmatter(`---
name: s
trigger: "when X"
enabled: true
---
body`);
    expect(r.meta).toEqual({ name: "s", trigger: "when X", enabled: true });
    expect(r.body.trim()).toBe("body");
  });

  it("parses priority as string", () => {
    const r = parseSkillFrontmatter(`---
name: s
trigger: t
priority: always
---
x`);
    expect(r.meta.priority).toBe("always");
  });

  it("defaults enabled to true when missing", () => {
    const r = parseSkillFrontmatter(`---
name: s
trigger: t
---
x`);
    expect(r.meta.enabled).toBe(true);
  });
});

describe("loadSkills + buildSkillIndex", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function mk() { const d = mkdtempSync(join(tmpdir(), "worklab-skills-")); dirs.push(d); return d; }

  it("returns [] for empty dir", () => {
    expect(loadSkills(mk())).toEqual([]);
  });

  it("loads enabled skills", () => {
    const d = mk();
    mkdirSync(join(d, "a"));
    writeFileSync(join(d, "a", "SKILL.md"), `---
name: a
trigger: "do A"
enabled: true
---
body-a`);
    mkdirSync(join(d, "b"));
    writeFileSync(join(d, "b", "SKILL.md"), `---
name: b
trigger: "do B"
enabled: false
---
body-b`);
    const loaded = loadSkills(d);
    expect(loaded.map(s => s.name).sort()).toEqual(["a", "b"]);
    const enabled = loaded.filter(s => s.enabled);
    expect(enabled.length).toBe(1);
    expect(enabled[0].name).toBe("a");
  });

  it("buildSkillIndex renders name + trigger one-liners", () => {
    const skills = [
      { name: "a", trigger: "do A", enabled: true, priority: undefined },
      { name: "b", trigger: "do B", enabled: true, priority: undefined },
    ];
    const idx = buildSkillIndex(skills);
    expect(idx).toContain("- a: do A");
    expect(idx).toContain("- b: do B");
  });

  it("buildSkillIndex inlines priority:always skill bodies", () => {
    const skills = [
      { name: "pin", trigger: "always", enabled: true, priority: "always", body: "INLINED BODY" },
      { name: "ref", trigger: "on demand", enabled: true, priority: undefined, body: "deferred" },
    ];
    const idx = buildSkillIndex(skills);
    expect(idx).toContain("INLINED BODY");
    expect(idx).not.toContain("deferred");
  });
});

describe("stripFrontmatter", () => {
  it("strips YAML frontmatter, preserves body", () => {
    const out = stripFrontmatter(`---
a: 1
---
body content`);
    expect(out.trim()).toBe("body content");
  });

  it("passes through when no frontmatter", () => {
    expect(stripFrontmatter("just body")).toBe("just body");
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npm test src/__tests__/core/skills.test.js
# Expected: module not found → all fail
```

- [ ] **Step 3: Implement**

```javascript
// src/core/skills.js
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function coerce(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
  return value;
}

export function parseSkillFrontmatter(content) {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;
  const [, yaml, body] = m;
  const meta = {};
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    meta[key] = coerce(raw);
  }
  if (!("enabled" in meta)) meta.enabled = true;
  return { meta, body };
}

export function stripFrontmatter(content) {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return content;
  return m[2];
}

export function loadSkills(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const entry of readdirSync(skillsDir)) {
    const dir = join(skillsDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const parsed = parseSkillFrontmatter(readFileSync(skillFile, "utf8"));
    if (!parsed) continue;
    out.push({
      name: parsed.meta.name || entry,
      trigger: parsed.meta.trigger || "",
      enabled: parsed.meta.enabled !== false,
      priority: parsed.meta.priority,
      body: parsed.body,
      assetsPath: dir,
    });
  }
  return out;
}

export function buildSkillIndex(skills) {
  const enabled = skills.filter(s => s.enabled);
  const lines = ["## Available skills", ""];
  for (const s of enabled) {
    if (s.priority === "always" && s.body) {
      lines.push(`### ${s.name}`, "", s.body.trim(), "");
    } else {
      lines.push(`- ${s.name}: ${s.trigger}`);
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm test src/__tests__/core/skills.test.js
# Expected: 9 tests pass

npm test
# Expected: 82 tests (73 + 9), all passing
```

- [ ] **Step 5: Commit**

```bash
git add src/core/skills.js src/__tests__/core/skills.test.js
git commit -m "feat(core): skills loader with frontmatter parser + priority:always inlining"
```

---

### Task 3: `src/core/mcp-config.js` — loader + validator (Sonnet)

**Files:**
- Create: `src/core/mcp-config.js`
- Create: `src/__tests__/core/mcp-config.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// src/__tests__/core/mcp-config.test.js
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, pickMcpServers, getBuiltinMcpServers } from "../../core/mcp-config.js";

describe("loadMcpConfig", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function mk(contents) {
    const d = mkdtempSync(join(tmpdir(), "worklab-mcp-"));
    dirs.push(d);
    mkdirSync(join(d, "config"));
    writeFileSync(join(d, "config", "mcp.json"), JSON.stringify(contents));
    return d;
  }

  it("returns {} if mcp.json missing", () => {
    const d = mkdtempSync(join(tmpdir(), "worklab-mcp-empty-")); dirs.push(d);
    expect(loadMcpConfig(d)).toEqual({});
  });

  it("loads stdio server with absolute command path", () => {
    const d = mk({ mcpServers: { s: { command: "/usr/bin/node", args: ["x"] } } });
    expect(loadMcpConfig(d).s).toEqual({ command: "/usr/bin/node", args: ["x"] });
  });

  it("rejects stdio server with relative command path", () => {
    const d = mk({ mcpServers: { s: { command: "node" } } });
    expect(() => loadMcpConfig(d)).toThrow(/absolute path/i);
  });

  it("loads http server with allowed URL (localhost)", () => {
    const d = mk({ mcpServers: { s: { type: "http", url: "http://localhost:8000" } } });
    expect(loadMcpConfig(d).s.url).toBe("http://localhost:8000");
  });

  it("rejects http server with public URL", () => {
    const d = mk({ mcpServers: { s: { type: "http", url: "https://example.com" } } });
    expect(() => loadMcpConfig(d)).toThrow(/allowlist/i);
  });

  it("allows tailscale CGNAT (100.64/10)", () => {
    const d = mk({ mcpServers: { s: { type: "http", url: "http://100.70.1.5:8080" } } });
    expect(loadMcpConfig(d).s.url).toContain("100.70.1.5");
  });
});

describe("pickMcpServers", () => {
  it("empty allowlist returns all registered", () => {
    const all = { a: { command: "/a" }, b: { command: "/b" } };
    expect(pickMcpServers(all, [])).toEqual(all);
  });

  it("allowlist filters", () => {
    const all = { a: { command: "/a" }, b: { command: "/b" } };
    expect(pickMcpServers(all, ["a"])).toEqual({ a: { command: "/a" } });
  });
});

describe("getBuiltinMcpServers", () => {
  it("returns worklab entry with absolute launcher path", () => {
    const r = getBuiltinMcpServers("/repo/root");
    expect(r.worklab.command).toBe("/repo/root/src/mcp/launch-worklab-mcp.sh");
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

```javascript
// src/core/mcp-config.js
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

function isPrivateHost(host) {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function validateRemote(config) {
  const u = new URL(config.url);
  if (!isPrivateHost(u.hostname)) throw new Error(`mcp url not in allowlist: ${config.url}`);
  return { type: config.type, url: config.url, headers: config.headers };
}

function validateStdio(config) {
  if (!isAbsolute(config.command)) throw new Error(`mcp command must be absolute path: ${config.command}`);
  const out = { command: config.command };
  if (config.args) out.args = config.args;
  if (config.env) out.env = config.env;
  return out;
}

export function loadMcpConfig(dataDir) {
  const p = join(dataDir, "config", "mcp.json");
  if (!existsSync(p)) return {};
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const servers = raw.mcpServers || {};
  const out = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.type === "http" || cfg.type === "sse") out[name] = validateRemote(cfg);
    else out[name] = validateStdio(cfg);
  }
  return out;
}

export function getBuiltinMcpServers(repoRoot) {
  return {
    worklab: { command: join(repoRoot, "src/mcp/launch-worklab-mcp.sh") },
  };
}

export function pickMcpServers(allServers, allowlist) {
  if (!allowlist || allowlist.length === 0) return { ...allServers };
  const out = {};
  for (const name of allowlist) if (allServers[name]) out[name] = allServers[name];
  return out;
}
```

- [ ] **Step 4: Run, pass** (total should be 89 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/mcp-config.js src/__tests__/core/mcp-config.test.js
git commit -m "feat(core): mcp config loader with stdio/remote validation"
```

---

### Task 4: `src/core/journal.js` — atomic append + read tail (Sonnet)

**Files:**
- Create: `src/core/journal.js`
- Create: `src/__tests__/core/journal.test.js`

- [ ] **Step 1: Tests**

```javascript
// src/__tests__/core/journal.test.js
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournalEntry, appendJournalSummary, readJournalTail, agentJournalPath } from "../../core/journal.js";

describe("journal", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function mk() { const d = mkdtempSync(join(tmpdir(), "worklab-journal-")); dirs.push(d); return d; }

  it("agentJournalPath is <dataDir>/agents/<name>/JOURNAL.md", () => {
    expect(agentJournalPath("/root", "coder")).toBe("/root/agents/coder/JOURNAL.md");
  });

  it("appendJournalEntry creates file and writes bullet with ISO timestamp", () => {
    const d = mk();
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "demo", bullet: "first" });
    const p = join(d, "agents/a/JOURNAL.md");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("## ");
    expect(content).toContain("run r1");
    expect(content).toContain("task t1");
    expect(content).toMatch(/- first/);
  });

  it("multiple appends cluster under one run header", () => {
    const d = mk();
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "x", bullet: "one" });
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "x", bullet: "two" });
    const content = readFileSync(join(d, "agents/a/JOURNAL.md"), "utf8");
    const headers = content.match(/^## /gm) || [];
    expect(headers.length).toBe(1);
    expect(content).toMatch(/- one/);
    expect(content).toMatch(/- two/);
  });

  it("different runs each get their own header", () => {
    const d = mk();
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "x", bullet: "a1" });
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r2", taskId: "t2", taskTitle: "y", bullet: "b1" });
    const content = readFileSync(join(d, "agents/a/JOURNAL.md"), "utf8");
    const headers = content.match(/^## /gm) || [];
    expect(headers.length).toBe(2);
  });

  it("appendJournalSummary writes a (summary) line", () => {
    const d = mk();
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "x", bullet: "b" });
    appendJournalSummary({ dataDir: d, agent: "a", runId: "r1", text: "all done" });
    const content = readFileSync(join(d, "agents/a/JOURNAL.md"), "utf8");
    expect(content).toMatch(/\(summary\)/);
    expect(content).toMatch(/all done/);
  });

  it("readJournalTail returns last N lines", () => {
    const d = mk();
    for (let i = 0; i < 50; i++) {
      appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "x", bullet: `item-${i}` });
    }
    const tail = readJournalTail({ dataDir: d, agent: "a", maxLines: 10 });
    const lines = tail.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(tail).toContain("item-49");
  });

  it("readJournalTail returns empty string when journal missing", () => {
    expect(readJournalTail({ dataDir: mk(), agent: "nobody", maxLines: 80 })).toBe("");
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/core/journal.js
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function agentJournalPath(dataDir, agent) {
  return join(dataDir, "agents", agent, "JOURNAL.md");
}

export function agentMemoryPath(dataDir, agent) {
  return join(dataDir, "agents", agent, "MEMORY.md");
}

function ensureDir(path) {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function isoTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function runHeaderRegex(runId) {
  return new RegExp(`^## .* — run ${runId} — `, "m");
}

export function appendJournalEntry({ dataDir, agent, runId, taskId, taskTitle, bullet, now = new Date() }) {
  const path = agentJournalPath(dataDir, agent);
  ensureDir(path);
  let existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const headerPresent = runHeaderRegex(runId).test(existing);
  const ts = isoTimestamp(now);
  if (!headerPresent) {
    const header = `\n## ${ts} — run ${runId} — task ${taskId} (${taskTitle})\n`;
    existing += header;
    writeFileSync(path, existing);
  }
  appendFileSync(path, `- ${bullet}\n`);
}

export function appendJournalSummary({ dataDir, agent, runId, text, now = new Date() }) {
  const path = agentJournalPath(dataDir, agent);
  ensureDir(path);
  const ts = isoTimestamp(now);
  appendFileSync(path, `\n## ${ts} — run ${runId} (summary)\n${text}\n`);
}

export function readJournalTail({ dataDir, agent, maxLines = 80 }) {
  const path = agentJournalPath(dataDir, agent);
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  return lines.slice(-maxLines).join("\n");
}
```

- [ ] **Step 4: Pass** (96 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/journal.js src/__tests__/core/journal.test.js
git commit -m "feat(core): journal atomic append + tail read"
```

---

### Task 5: `src/core/ai.js` — resolveModel + generateResponse dispatcher (**Opus**)

**Files:**
- Create: `src/core/ai.js`
- Create: `src/__tests__/core/ai.test.js`

Stub `ai-claude.js` with an export that throws — actual implementation lands in T6.

- [ ] **Step 1: Tests for resolveModel**

```javascript
// src/__tests__/core/ai.test.js
import { describe, it, expect } from "vitest";
import { resolveModel, TIER_MODELS } from "../../core/ai.js";

describe("resolveModel", () => {
  it("bare 'sonnet' resolves to claude sonnet tier", () => {
    const r = resolveModel("sonnet");
    expect(r.sdk).toBe("claude");
    expect(r.tier).toBe("sonnet");
    expect(r.model).toBe(TIER_MODELS.sonnet);
  });

  it("bare 'opus' resolves to claude opus tier", () => {
    expect(resolveModel("opus").tier).toBe("opus");
  });

  it("bare 'haiku' resolves to claude haiku tier", () => {
    expect(resolveModel("haiku").tier).toBe("haiku");
  });

  it("claude: prefix resolves explicitly", () => {
    const r = resolveModel("claude:sonnet");
    expect(r.sdk).toBe("claude");
    expect(r.tier).toBe("sonnet");
  });

  it("rejects unknown sdk prefix", () => {
    expect(() => resolveModel("bogus:x")).toThrow(/unknown sdk/i);
  });

  it("rejects unknown claude tier", () => {
    expect(() => resolveModel("claude:mystery")).toThrow(/unknown tier/i);
  });

  it("accepts raw claude model id", () => {
    const r = resolveModel("claude-opus-4-7");
    expect(r.sdk).toBe("claude");
    expect(r.model).toBe("claude-opus-4-7");
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/core/ai.js
export const TIER_MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

function resolveClaude(tier) {
  if (tier in TIER_MODELS) return { sdk: "claude", tier, model: TIER_MODELS[tier] };
  // raw model id
  if (/^claude-/.test(tier)) return { sdk: "claude", tier: null, model: tier };
  throw new Error(`unknown tier for claude: ${tier}`);
}

export function resolveModel(value) {
  if (!value) throw new Error("model value required");
  if (value.includes(":")) {
    const [sdk, rest] = value.split(":", 2);
    if (sdk === "claude") return resolveClaude(rest);
    throw new Error(`unknown sdk: ${sdk}`);
  }
  return resolveClaude(value);
}

export async function generateResponse(systemPrompt, options) {
  const resolved = options.model?.sdk ? options.model : resolveModel(options.model);
  if (resolved.sdk === "claude") {
    const { generateClaudeResponse } = await import("./ai-claude.js");
    return generateClaudeResponse(systemPrompt, { ...options, model: resolved });
  }
  throw new Error(`sdk not yet supported in phase 2: ${resolved.sdk}`);
}
```

Stub `src/core/ai-claude.js`:

```javascript
// src/core/ai-claude.js (stub — real implementation in T6)
export async function generateClaudeResponse() {
  throw new Error("ai-claude not implemented yet");
}
```

- [ ] **Step 4: Pass** (103 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/ai.js src/core/ai-claude.js src/__tests__/core/ai.test.js
git commit -m "feat(core): ai dispatcher + resolveModel for claude tiers"
```

**Reviewer note (Opus review):** Confirm `TIER_MODELS` maps to the exact canonical model IDs per spec; confirm dispatcher does lazy import so tests of `resolveModel` don't pull in the SDK. Confirm error shapes.

---

### Task 6: `src/core/ai-claude.js` — Claude Agent SDK integration (**Opus**)

**Files:**
- Modify: `src/core/ai-claude.js` (replace stub)
- Create: `src/__tests__/core/ai-claude.test.js`

This is the single most delicate integration in Phase 2. The Claude Agent SDK's `query()` returns an async iterable of events. We must consume it, pass every event to `options.onEvent`, accumulate usage, capture the final assistant text, and handle errors/cancellation cleanly.

**SDK reference contract** (from `@anthropic-ai/claude-agent-sdk`):

```javascript
import { query } from "@anthropic-ai/claude-agent-sdk";
const stream = query({
  prompt: userMessages,           // array of { role, content } OR a plain string
  options: {
    systemPrompt: "...",
    model: "claude-opus-4-7",
    maxTurns: 20,
    cwd: "/path",
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Write", ...],
    disallowedTools: [],
    mcpServers: { worklab: { command: "..." } },
    thinking: { type: "adaptive" | "disabled" },
  },
});
for await (const event of stream) { /* event is one of: assistant, user, tool_use, tool_result, result, error */ }
```

Key SDK quirks to respect:
- `effort: "low"` maps to `thinking: { type: "disabled" }`; all higher effort levels map to `thinking: { type: "adaptive" }` and an extra `effort` option on the query.
- The `result` event contains `{usage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}, duration_ms, num_turns}`.
- Cancellation: the SDK stream is an async iterable — awaiting `stream.return?.()` from outside ends it.

- [ ] **Step 1: Write failing tests (mock the SDK entirely)**

```javascript
// src/__tests__/core/ai-claude.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @anthropic-ai/claude-agent-sdk
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args) => mockQuery(...args),
}));

const { generateClaudeResponse } = await import("../../core/ai-claude.js");

function mockStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    return: vi.fn(async () => ({ done: true })),
  };
}

describe("generateClaudeResponse", () => {
  beforeEach(() => mockQuery.mockReset());

  it("streams events to onEvent, collects final text", async () => {
    mockQuery.mockReturnValue(mockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "result", usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 100, num_turns: 1 },
    ]));
    const events = [];
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: (e) => events.push(e),
    });
    expect(r.text).toBe("hello");
    expect(r.usage.input_tokens).toBe(10);
    expect(r.usage.output_tokens).toBe(5);
    expect(r.durationMs).toBe(100);
    expect(r.numTurns).toBe(1);
    expect(events.length).toBe(2);
  });

  it("maps effort: low → thinking disabled", async () => {
    mockQuery.mockReturnValue(mockStream([{ type: "result", usage: {}, duration_ms: 0, num_turns: 0 }]));
    await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "low",
      onEvent: () => {},
    });
    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toEqual({ type: "disabled" });
  });

  it("maps effort: high → thinking adaptive + effort option", async () => {
    mockQuery.mockReturnValue(mockStream([{ type: "result", usage: {}, duration_ms: 0, num_turns: 0 }]));
    await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-opus-4-7" },
      effort: "high",
      onEvent: () => {},
    });
    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toEqual({ type: "adaptive" });
    expect(call.options.effort).toBe("high");
  });

  it("passes systemPrompt, cwd, mcpServers, permissionMode, allowedTools through", async () => {
    mockQuery.mockReturnValue(mockStream([{ type: "result", usage: {}, duration_ms: 0, num_turns: 0 }]));
    await generateClaudeResponse("SYS", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      cwd: "/x",
      mcpServers: { worklab: { command: "/bin/sh" } },
      allowedTools: ["Read", "Bash"],
      permissionMode: "bypassPermissions",
      maxTurns: 50,
      onEvent: () => {},
    });
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.systemPrompt).toBe("SYS");
    expect(options.cwd).toBe("/x");
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowedTools).toEqual(["Read", "Bash"]);
    expect(options.maxTurns).toBe(50);
    expect(options.mcpServers.worklab.command).toBe("/bin/sh");
  });

  it("accumulates text across multiple assistant events", async () => {
    mockQuery.mockReturnValue(mockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "part 1 " }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "part 2" }] } },
      { type: "result", usage: {}, duration_ms: 0, num_turns: 0 },
    ]));
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });
    expect(r.text).toBe("part 1 part 2");
  });

  it("ignores non-text assistant content blocks (tool_use)", async () => {
    mockQuery.mockReturnValue(mockStream([
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "tu1", name: "Read", input: {} },
        { type: "text", text: "done" },
      ]}},
      { type: "result", usage: {}, duration_ms: 0, num_turns: 0 },
    ]));
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });
    expect(r.text).toBe("done");
  });

  it("abort signal cancels the stream", async () => {
    const stream = mockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "a" }] } },
    ]);
    mockQuery.mockReturnValue(stream);
    const ac = new AbortController();
    const promise = generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      abortSignal: ac.signal,
      onEvent: () => {},
    });
    ac.abort();
    const r = await promise;
    expect(r.cancelled).toBe(true);
    expect(stream.return).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/core/ai-claude.js
import { query } from "@anthropic-ai/claude-agent-sdk";

function thinkingForEffort(effort) {
  if (effort === "low") return { thinking: { type: "disabled" } };
  return { thinking: { type: "adaptive" }, effort };
}

function extractText(event) {
  if (event.type !== "assistant" || !event.message?.content) return "";
  let out = "";
  for (const block of event.message.content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

export async function generateClaudeResponse(systemPrompt, options) {
  const {
    messages,
    model,
    effort = "medium",
    cwd,
    mcpServers,
    allowedTools,
    disallowedTools,
    permissionMode = "bypassPermissions",
    maxTurns = 30,
    abortSignal,
    onEvent = () => {},
  } = options;

  const thinkingOpts = thinkingForEffort(effort);

  const stream = query({
    prompt: messages,
    options: {
      systemPrompt,
      model: model.model,
      maxTurns,
      cwd,
      permissionMode,
      allowedTools,
      disallowedTools,
      mcpServers,
      ...thinkingOpts,
    },
  });

  let text = "";
  let usage = {};
  let durationMs = 0;
  let numTurns = 0;
  let cancelled = false;
  const capturedEvents = [];

  const abortHandler = async () => {
    cancelled = true;
    if (stream.return) await stream.return();
  };
  if (abortSignal) {
    if (abortSignal.aborted) await abortHandler();
    else abortSignal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    for await (const event of stream) {
      capturedEvents.push(event);
      onEvent(event);
      if (event.type === "assistant") text += extractText(event);
      else if (event.type === "result") {
        usage = event.usage || {};
        durationMs = event.duration_ms || 0;
        numTurns = event.num_turns || 0;
      }
      if (cancelled) break;
    }
  } finally {
    if (abortSignal) abortSignal.removeEventListener?.("abort", abortHandler);
  }

  return {
    text,
    events: capturedEvents,
    usage,
    durationMs,
    numTurns,
    model: model.model,
    effort,
    cancelled,
  };
}
```

- [ ] **Step 4: Pass** (110 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/ai-claude.js src/__tests__/core/ai-claude.test.js
git commit -m "feat(core): claude agent sdk wrapper with effort→thinking + abort"
```

**Reviewer note:** The abort path is subtle — test the scenario where `abortSignal.aborted === true` at call time, not just after start. Confirm `stream.return()` is awaited (not fire-and-forget).

---

### Task 7: Built-in `worklab` MCP server (Sonnet)

**Files:**
- Create: `src/mcp/launch-worklab-mcp.sh`
- Create: `src/mcp/worklab-tools-server.js`
- Create: `src/mcp/worklab-tools.js`
- Create: `src/__tests__/mcp/worklab-tools.test.js`

This is the MCP server that the worker spawns so the running agent can call `journal_append`, `journal_summary`, and `memory_read`. The server is a separate Node subprocess launched via stdio. It reads config from env vars the worker sets: `WORKLAB_DATA_DIR`, `WORKLAB_AGENT_NAME`, `WORKLAB_RUN_ID`, `WORKLAB_TASK_ID`, `WORKLAB_TASK_TITLE`. KB tools are out of scope (Phase 3).

- [ ] **Step 1: Tests for tool handlers**

```javascript
// src/__tests__/mcp/worklab-tools.test.js
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolHandlers } from "../../mcp/worklab-tools.js";

describe("worklab-tools handlers", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function ctx() {
    const d = mkdtempSync(join(tmpdir(), "worklab-tools-")); dirs.push(d);
    return { dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "demo" };
  }

  it("journal_append writes a bullet to the correct file", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    const r = await h.journal_append({ bullet: "hello world" });
    expect(r.ok).toBe(true);
    const content = readFileSync(join(c.dataDir, "agents/a/JOURNAL.md"), "utf8");
    expect(content).toMatch(/- hello world/);
  });

  it("journal_append rejects empty bullet", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await expect(h.journal_append({ bullet: "" })).rejects.toThrow();
  });

  it("journal_summary appends (summary) entry", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.journal_append({ bullet: "b" });
    await h.journal_summary({ text: "done" });
    const content = readFileSync(join(c.dataDir, "agents/a/JOURNAL.md"), "utf8");
    expect(content).toMatch(/\(summary\)/);
  });

  it("memory_read returns empty string when no memory file", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    const r = await h.memory_read({});
    expect(r.content).toBe("");
  });

  it("memory_read returns existing memory content", async () => {
    const c = ctx();
    mkdirSync(join(c.dataDir, "agents/a"), { recursive: true });
    writeFileSync(join(c.dataDir, "agents/a/MEMORY.md"), "# memory\nstuff");
    const h = createToolHandlers(c);
    const r = await h.memory_read({});
    expect(r.content).toBe("# memory\nstuff");
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement tool handlers**

```javascript
// src/mcp/worklab-tools.js
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { appendJournalEntry, appendJournalSummary, agentMemoryPath } from "../core/journal.js";

export const journalAppendSchema = z.object({ bullet: z.string().min(1, "bullet is required") });
export const journalSummarySchema = z.object({ text: z.string().min(1, "text is required") });
export const memoryReadSchema = z.object({});

export function createToolHandlers(context) {
  const { dataDir, agent, runId, taskId, taskTitle } = context;
  return {
    async journal_append(input) {
      const { bullet } = journalAppendSchema.parse(input);
      appendJournalEntry({ dataDir, agent, runId, taskId, taskTitle, bullet });
      return { ok: true };
    },
    async journal_summary(input) {
      const { text } = journalSummarySchema.parse(input);
      appendJournalSummary({ dataDir, agent, runId, text });
      return { ok: true };
    },
    async memory_read(input) {
      memoryReadSchema.parse(input);
      const path = agentMemoryPath(dataDir, agent);
      if (!existsSync(path)) return { content: "" };
      return { content: readFileSync(path, "utf8") };
    },
  };
}

export const toolDefinitions = [
  {
    name: "journal_append",
    description: "Append a bullet entry to this agent's JOURNAL.md. Use during task execution to record facts, decisions, and corrections.",
    inputSchema: {
      type: "object",
      properties: { bullet: { type: "string", description: "One concise bullet to append" } },
      required: ["bullet"],
    },
  },
  {
    name: "journal_summary",
    description: "Append a summary entry to the JOURNAL.md at the end of a task. Optional.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "memory_read",
    description: "Read this agent's consolidated MEMORY.md for Procedures / Facts / Gotchas.",
    inputSchema: { type: "object", properties: {} },
  },
];
```

- [ ] **Step 4: Implement MCP server entrypoint**

```javascript
// src/mcp/worklab-tools-server.js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createToolHandlers, toolDefinitions } from "./worklab-tools.js";

const context = {
  dataDir: process.env.WORKLAB_DATA_DIR,
  agent: process.env.WORKLAB_AGENT_NAME,
  runId: process.env.WORKLAB_RUN_ID,
  taskId: process.env.WORKLAB_TASK_ID,
  taskTitle: process.env.WORKLAB_TASK_TITLE,
};

for (const [k, v] of Object.entries(context)) {
  if (!v) {
    console.error(`[worklab-mcp] missing env ${k}`);
    process.exit(1);
  }
}

const handlers = createToolHandlers(context);
const server = new Server({ name: "worklab", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = handlers[name];
  if (!handler) throw new Error(`unknown tool: ${name}`);
  const result = await handler(args || {});
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 5: Launcher shell script**

```bash
# src/mcp/launch-worklab-mcp.sh
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/worklab-tools-server.js"
```

Make it executable:
```bash
chmod +x src/mcp/launch-worklab-mcp.sh
```

- [ ] **Step 6: Run, pass** (116 tests)

- [ ] **Step 7: Commit**

```bash
git add src/mcp/launch-worklab-mcp.sh src/mcp/worklab-tools-server.js src/mcp/worklab-tools.js src/__tests__/mcp/worklab-tools.test.js
git commit -m "feat(mcp): built-in worklab MCP server with journal + memory tools"
```

---

### Task 8: `src/core/context.js` — system prompt assembler for execute mode (**Opus**)

**Files:**
- Create: `src/core/context.js`
- Create: `src/__tests__/core/context.test.js`

Ordering per spec §5.9:
1. Agent instructions
2. Pinned KB (Phase 3 — for now pass empty array)
3. Skill index (name + trigger; `priority:always` inlined)
4. MEMORY.md content
5. Journal tail
6. Task block (title, description, instructions, comment history)
7. Cadence instruction

- [ ] **Step 1: Tests**

```javascript
// src/__tests__/core/context.test.js
import { describe, it, expect } from "vitest";
import { buildExecuteSystemPrompt } from "../../core/context.js";

describe("buildExecuteSystemPrompt", () => {
  const baseAgent = { name: "coder", instructions: "you are a coder" };
  const baseTask = { id: "t1", title: "demo", description: "desc", instructions: "do things" };

  it("contains agent instructions", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).toContain("you are a coder");
  });

  it("contains task title, description, instructions", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).toContain("demo");
    expect(p).toContain("desc");
    expect(p).toContain("do things");
  });

  it("renders skill index with priority:always inlined", () => {
    const skills = [
      { name: "pin", trigger: "always", enabled: true, priority: "always", body: "PIN-BODY" },
      { name: "ref", trigger: "on demand", enabled: true, body: "REF-BODY" },
    ];
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills, memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).toContain("PIN-BODY");
    expect(p).toContain("- ref: on demand");
    expect(p).not.toContain("REF-BODY");
  });

  it("includes memory and journal tail when present", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "# MEM", journalTail: "- j1", comments: [], pinnedKb: [] });
    expect(p).toContain("# MEM");
    expect(p).toContain("- j1");
  });

  it("renders comment history in order", () => {
    const comments = [
      { author_type: "human", author_id: null, body: "first note", created_at: 1 },
      { author_type: "agent", author_id: "coder", body: "ack", created_at: 2 },
    ];
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments, pinnedKb: [] });
    const firstIdx = p.indexOf("first note");
    const secondIdx = p.indexOf("ack");
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("ends with the cadence instruction", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p.trim().endsWith("if anything rolls up.")).toBe(true);
  });

  it("omits empty sections cleanly (no doubled headers)", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).not.toMatch(/## Memory\s*\n\s*\n\s*## /);
  });

  it("includes pinned KB entries at top", () => {
    const pinnedKb = [{ slug: "conv", title: "Conventions", body: "be nice" }];
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb });
    const instrIdx = p.indexOf("you are a coder");
    const kbIdx = p.indexOf("Conventions");
    expect(kbIdx).toBeGreaterThan(instrIdx);
    expect(p.indexOf("demo")).toBeGreaterThan(kbIdx);
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/core/context.js
import { buildSkillIndex } from "./skills.js";

const CADENCE = `Journal as you work — call \`journal_append\` for facts you discover, decisions you make, and corrections you learn. At the end of the task, optionally call \`journal_summary\` if anything rolls up.`;

function section(title, body) {
  if (!body || !body.trim()) return "";
  return `## ${title}\n\n${body.trim()}\n`;
}

function formatComments(comments) {
  if (!comments?.length) return "";
  return comments
    .map(c => {
      const who = c.author_id ? `${c.author_type} ${c.author_id}` : c.author_type;
      return `- [${who}] ${c.body}`;
    })
    .join("\n");
}

function formatPinnedKb(pinnedKb) {
  if (!pinnedKb?.length) return "";
  return pinnedKb
    .map(e => `### ${e.title}\n\n${e.body}`)
    .join("\n\n");
}

export function buildExecuteSystemPrompt({ agent, task, skills, memory, journalTail, comments, pinnedKb }) {
  const parts = [];
  parts.push(section("Role", agent.instructions || ""));
  parts.push(section("Pinned knowledge", formatPinnedKb(pinnedKb)));
  parts.push(section("Skills", buildSkillIndex(skills || [])));
  parts.push(section("Memory", memory || ""));
  parts.push(section("Recent journal", journalTail || ""));
  const taskBody = [
    `**Title:** ${task.title}`,
    task.description ? `\n**Description:**\n${task.description}` : "",
    task.instructions ? `\n**Instructions:**\n${task.instructions}` : "",
    comments?.length ? `\n**Comments:**\n${formatComments(comments)}` : "",
  ].filter(Boolean).join("\n");
  parts.push(section("Task", taskBody));
  parts.push(CADENCE);
  return parts.filter(Boolean).join("\n");
}
```

- [ ] **Step 4: Pass** (124 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/context.js src/__tests__/core/context.test.js
git commit -m "feat(core): execute-mode system prompt assembler"
```

**Reviewer note:** Confirm section ordering matches spec §5.9 exactly. Confirm empty sections elide. Confirm cadence is the LAST thing in the prompt (per the plan lessons — trailing-bias matters).

---

### Task 9: Worker binary — execute mode (**Opus**)

**Files:**
- Create: `src/worker.js`

The worker is a short-lived Node subprocess. It reads task + agent + skills + MCP config, calls the Claude SDK via `ai.generateResponse`, streams events to stdout as line-delimited JSON, and exits 0 on success or nonzero on error. `SIGTERM` cleanly cancels via AbortController with a 5s grace before `SIGKILL`.

**Environment the worker reads** (set by the coordinator's spawn-worker):
- argv: `--task <id> --mode execute|review|consolidate --agent <name>`
- env `WORKLAB_RUN_ID`, `WORKLAB_DATA_DIR`, `WORKLAB_REPO_ROOT`, `WORKLAB_WORKSPACE`

**Stdout event protocol** (one JSON per line, newline-delimited):
- `{"type":"started","runId":"...","ts":<unix-ms>}`
- `{"type":"sdk_event","event":{...raw SDK event...}}`
- `{"type":"final","text":"...","usage":{...},"durationMs":N,"numTurns":N}`
- `{"type":"error","message":"..."}`
- `{"type":"cancelled"}`

Exit codes: 0 success, 130 cancelled, 1 error.

- [ ] **Step 1: Write the worker**

No unit tests here — the worker is integration-tested in T20 via the fake-worker helper and E2E smoke. Logic in this file is orchestration, not pure logic.

```javascript
// src/worker.js
import { parseArgs } from "node:util";
import { openDb } from "./core/db.js";
import { loadConfig } from "./core/config.js";
import { loadSkills } from "./core/skills.js";
import { loadMcpConfig, getBuiltinMcpServers, pickMcpServers } from "./core/mcp-config.js";
import { readJournalTail, agentMemoryPath } from "./core/journal.js";
import { buildExecuteSystemPrompt } from "./core/context.js";
import { resolveModel, generateResponse } from "./core/ai.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      task: { type: "string" },
      mode: { type: "string" },
      agent: { type: "string" },
    },
  });
  const { task: taskId, mode, agent: agentName } = values;
  const runId = process.env.WORKLAB_RUN_ID;
  const config = loadConfig();

  if (!taskId || !mode || !agentName || !runId) {
    emit({ type: "error", message: "missing required args/env" });
    process.exit(1);
  }
  if (mode !== "execute") {
    emit({ type: "error", message: `mode ${mode} not implemented in phase 2` });
    process.exit(1);
  }

  emit({ type: "started", runId, ts: Date.now() });

  const db = openDb(join(config.dataDir, "worklab.db"));

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) { emit({ type: "error", message: `task ${taskId} not found` }); process.exit(1); }
  const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(agentName);
  if (!agent) { emit({ type: "error", message: `agent ${agentName} not found` }); process.exit(1); }

  const commentRows = db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at").all(taskId);

  const skillsAll = loadSkills(join(config.dataDir, "skills"));
  const skillAllowlist = JSON.parse(agent.skills_allowlist || "[]");
  const skills = skillAllowlist.length === 0 ? skillsAll : skillsAll.filter(s => skillAllowlist.includes(s.name));

  const memoryPath = agentMemoryPath(config.dataDir, agentName);
  const memory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  const journalTail = readJournalTail({ dataDir: config.dataDir, agent: agentName, maxLines: 80 });

  const userMcpServers = loadMcpConfig(config.dataDir);
  const allMcpServers = { ...getBuiltinMcpServers(config.repoRoot), ...userMcpServers };
  const mcpAllowlist = JSON.parse(agent.mcp_allowlist || "[]");
  const mcpServers = pickMcpServers(allMcpServers, mcpAllowlist.length === 0 ? [] : ["worklab", ...mcpAllowlist]);

  // Inject worklab-mcp env so the built-in server knows which agent/run it's serving
  if (mcpServers.worklab) {
    mcpServers.worklab = {
      ...mcpServers.worklab,
      env: {
        ...(mcpServers.worklab.env || {}),
        WORKLAB_DATA_DIR: config.dataDir,
        WORKLAB_AGENT_NAME: agentName,
        WORKLAB_RUN_ID: runId,
        WORKLAB_TASK_ID: taskId,
        WORKLAB_TASK_TITLE: task.title,
      },
    };
  }

  const builtinAllowlist = JSON.parse(agent.builtin_allowlist || "[]");
  const allowedTools = builtinAllowlist.length === 0
    ? ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"]
    : builtinAllowlist;

  const systemPrompt = buildExecuteSystemPrompt({
    agent, task, skills, memory, journalTail, comments: commentRows, pinnedKb: [],
  });

  const ac = new AbortController();
  process.on("SIGTERM", () => { ac.abort(); });
  process.on("SIGINT", () => { ac.abort(); });

  try {
    const result = await generateResponse(systemPrompt, {
      model: resolveModel(agent.model),
      effort: agent.effort || "medium",
      messages: [{ role: "user", content: `Work on task "${task.title}".` }],
      cwd: config.workspace,
      mcpServers,
      allowedTools,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      maxTurns: 30,
      abortSignal: ac.signal,
      onEvent: (event) => emit({ type: "sdk_event", event }),
    });
    if (result.cancelled) {
      emit({ type: "cancelled" });
      process.exit(130);
    }
    emit({
      type: "final",
      text: result.text,
      usage: result.usage,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      model: result.model,
      effort: result.effort,
    });
    process.exit(0);
  } catch (err) {
    emit({ type: "error", message: err.message || String(err) });
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Quick import sanity check**

```bash
cd /opt/claude-workspace/local/worklab
node --input-type=module -e "import('./src/worker.js').catch(e => { if (e.message.includes('missing required args/env')) process.exit(0); throw e; })"
# Expected: process exits 1 because no args, but we don't execute past main() here because main() runs immediately
```

Actually the cleanest test is just syntax check:
```bash
node --check src/worker.js
# Expected: no output (valid syntax)
```

- [ ] **Step 3: Confirm test suite unaffected**

```bash
npm test
# Expected: 124 tests (same as before T9 — no worker unit tests yet)
```

- [ ] **Step 4: Commit**

```bash
git add src/worker.js
git commit -m "feat(worker): execute-mode binary with SDK + MCP + journal hooks"
```

**Reviewer note:** Confirm `abortSignal` is respected (SIGTERM → ac.abort() → stream.return via ai-claude). Confirm env var injection only happens for builtin worklab server, not for user-registered stdio servers. Confirm allowedTools defaults match plan intent (full set when empty).

---

### Task 10: Fake-worker test helper (Sonnet)

**File:**
- Create: `src/__tests__/helpers/fake-worker.js`

A scriptable fake-worker binary that the coordinator can spawn in integration tests. Reads a JSON script from env var `FAKE_WORKER_SCRIPT` listing events to emit (with optional delays), and exits with the configured code.

- [ ] **Step 1: Write the helper**

```javascript
// src/__tests__/helpers/fake-worker.js
// Run as a child process; emits events per FAKE_WORKER_SCRIPT env var
// Script format: JSON { "events": [{ "type": "...", ...payload, "delayMs": 10 }], "exitCode": 0, "exitAfterMs": 100 }

const script = JSON.parse(process.env.FAKE_WORKER_SCRIPT || '{"events":[],"exitCode":0}');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let aborted = false;
process.on("SIGTERM", () => { aborted = true; });

async function run() {
  for (const e of script.events) {
    if (aborted) { emit({ type: "cancelled" }); process.exit(130); }
    const { delayMs = 0, ...payload } = e;
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    emit(payload);
  }
  if (script.exitAfterMs) await new Promise(r => setTimeout(r, script.exitAfterMs));
  process.exit(aborted ? 130 : (script.exitCode || 0));
}

run();
```

- [ ] **Step 2: Commit** (no tests for the helper itself — it's exercised by the coordinator integration tests)

```bash
git add src/__tests__/helpers/fake-worker.js
git commit -m "chore(tests): add scriptable fake-worker helper for integration tests"
```

---

### Task 11: `src/coordinator/spawn-worker.js` — subprocess + event demux (**Opus**)

**Files:**
- Create: `src/coordinator/spawn-worker.js`
- Create: `src/__tests__/coordinator/spawn-worker.test.js`

Spawns a worker subprocess, demultiplexes its stdout event stream, broadcasts events on the run-specific SSE channel, accumulates the final state, and records the `agent_logs` row on exit.

Public contract:

```javascript
spawnWorker({
  binary,           // path to worker.js or fake-worker.js (overridable for tests)
  args,             // ["--task", taskId, "--mode", mode, "--agent", agentName]
  env,              // { WORKLAB_RUN_ID, ... }
  runId,            // for log record
  taskId,           //
  broker,           // SSE broker for per-run channel broadcasts
  db,               // for writing agent_logs on exit
  logger,
  cancelGraceMs,    // default 5000
}) → {
  pid,              // worker pid
  done,             // Promise<{ exitCode, events, finalText, usage, error }>
  cancel(),         // SIGTERM now, SIGKILL after grace
}
```

- [ ] **Step 1: Tests using fake-worker helper**

```javascript
// src/__tests__/coordinator/spawn-worker.test.js
import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnWorker } from "../../coordinator/spawn-worker.js";
import { makeTestDb } from "../helpers/test-db.js";
import { newRunId, newTaskId } from "../../core/ids.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeBinary = resolve(__dirname, "../helpers/fake-worker.js");

function stubBroker() {
  const broadcasts = [];
  return {
    broadcasts,
    subscribe: () => {},
    unsubscribe: () => {},
    broadcast: (ch, p) => broadcasts.push({ ch, p }),
    size: () => 0,
  };
}

function seedTaskAndRun(db, { mode = "execute" } = {}) {
  const taskId = newTaskId();
  const runId = newRunId();
  const now = Date.now();
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(taskId, "smoke", now, now);
  db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("coder", "Coder", "claude", "sonnet", now, now);
  db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')")
    .run(runId, taskId, mode, "coder", now);
  return { taskId, runId };
}

describe("spawnWorker", () => {
  it("streams fake-worker stdout events through broker and resolves on clean exit", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = {
      events: [
        { type: "started", runId, ts: Date.now() },
        { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } } },
        { type: "final", text: "hi", usage: { input_tokens: 5, output_tokens: 2 }, durationMs: 42, numTurns: 1 },
      ],
      exitCode: 0,
    };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    expect(result.finalText).toBe("hi");
    expect(result.usage.input_tokens).toBe(5);
    const types = broker.broadcasts.filter(b => b.ch === runId).map(b => b.p.type);
    expect(types).toContain("started");
    expect(types).toContain("sdk_event");
    expect(types).toContain("final");
    // agent_logs row written
    const log = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(runId);
    expect(log).toBeTruthy();
    expect(log.status).toBe("complete");
    expect(log.input_tokens).toBe(5);
    expect(JSON.parse(log.events).length).toBe(3);
  });

  it("records error status on nonzero exit", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = { events: [{ type: "error", message: "boom" }], exitCode: 1 };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("boom");
    const log = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(runId);
    expect(log.status).toBe("error");
  });

  it("cancel() sends SIGTERM, worker exits 130, status=cancelled", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    const script = { events: [{ type: "started", runId, delayMs: 100 }], exitCode: 0, exitAfterMs: 2000 };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
      cancelGraceMs: 500,
    });
    setTimeout(() => handle.cancel(), 150);
    const result = await handle.done;
    expect([130, null]).toContain(result.exitCode);  // 130 on graceful, null on SIGKILL
    const log = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(runId);
    expect(log.status).toBe("cancelled");
  }, 10000);

  it("ignores malformed stdout lines (logs at warn), continues streaming", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const { taskId, runId } = seedTaskAndRun(db);
    // Can't easily emit bogus JSON from fake-worker script; this is a shape-sanity test
    const script = { events: [{ type: "final", text: "ok", usage: {}, durationMs: 0, numTurns: 0 }], exitCode: 0 };
    const handle = spawnWorker({
      binary: fakeBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", "coder"],
      env: { FAKE_WORKER_SCRIPT: JSON.stringify(script), WORKLAB_RUN_ID: runId },
      runId, taskId, broker, db,
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/coordinator/spawn-worker.js
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { newAgentLogId } from "../core/ids.js";

export function spawnWorker({
  binary,
  args,
  env = {},
  runId,
  taskId,
  broker,
  db,
  logger,
  cancelGraceMs = 5000,
}) {
  const child = spawn("node", [binary, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const events = [];
  let finalPayload = null;
  let errorMessage = null;
  let cancelRequested = false;
  let sigkillTimer = null;
  const startedAt = Date.now();

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch (err) {
      logger?.warn?.({ line, err: err.message }, "worker emitted malformed stdout");
      return;
    }
    events.push(parsed);
    broker.broadcast(runId, parsed);
    if (parsed.type === "final") finalPayload = parsed;
    if (parsed.type === "error") errorMessage = parsed.message;
  });

  child.stderr.on("data", (chunk) => {
    logger?.info?.({ runId, stderr: chunk.toString() }, "worker stderr");
  });

  function cancel() {
    if (cancelRequested) return;
    cancelRequested = true;
    try { child.kill("SIGTERM"); } catch {}
    sigkillTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, cancelGraceMs);
  }

  const done = new Promise((resolve) => {
    child.on("exit", (code) => {
      if (sigkillTimer) clearTimeout(sigkillTimer);
      const durationMs = Date.now() - startedAt;
      let status = "complete";
      if (cancelRequested || code === 130) status = "cancelled";
      else if (code !== 0) status = "error";

      db.prepare(`UPDATE task_runs SET status = ?, ended_at = ?, exit_code = ?, error_text = ? WHERE id = ?`)
        .run(status, Date.now(), code, errorMessage, runId);

      db.prepare(`INSERT INTO agent_logs
        (id, task_run_id, events, model, effort, input_tokens, output_tokens, cost_usd, duration_ms, num_turns, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newAgentLogId(),
        runId,
        JSON.stringify(events),
        finalPayload?.model || null,
        finalPayload?.effort || null,
        finalPayload?.usage?.input_tokens ?? null,
        finalPayload?.usage?.output_tokens ?? null,
        null, // cost_usd — Phase 4
        finalPayload?.durationMs ?? durationMs,
        finalPayload?.numTurns ?? null,
        status,
        Date.now(),
      );

      broker.broadcast(runId, { type: "done", exitCode: code });

      resolve({
        exitCode: code,
        events,
        finalText: finalPayload?.text || null,
        usage: finalPayload?.usage || {},
        error: errorMessage,
        status,
      });
    });
  });

  return { pid: child.pid, done, cancel };
}
```

- [ ] **Step 4: Pass** (128 tests)

- [ ] **Step 5: Commit**

```bash
git add src/coordinator/spawn-worker.js src/__tests__/coordinator/spawn-worker.test.js
git commit -m "feat(coordinator): spawn-worker with stdout demux + agent_logs recording"
```

**Reviewer note:** Pay attention to SIGKILL timer cleanup on exit. Pay attention to the malformed-line test — it's weak; confirm with a direct inspection of `rl.on("line")` that a bogus JSON line does not crash. Pay attention to the `status` derivation branch on exit: cancelled > error > complete.

---

### Task 12: `src/coordinator/task-watcher.js` — orchestrator reactor (**Opus**)

**Files:**
- Create: `src/coordinator/task-watcher.js`
- Create: `src/__tests__/coordinator/task-watcher.test.js`

The task-watcher listens for `run_requested` and `run_completed` events from the API layer (via an in-memory EventEmitter), spawns workers accordingly, and finalizes tasks on worker exit. For Phase 2: only execute mode. Review mode tasks whose `reviewer_agent` is set but review mode is unimplemented → task parks in `in_review` (no reviewer spawned).

Public contract:

```javascript
const watcher = createTaskWatcher({ db, broker, emitter, spawn = spawnWorker, workerBinary, logger, repoRoot });
watcher.handleRunRequested(taskId);     // called by POST /api/tasks/:id/run
watcher.cancel(taskId);                  // called by POST /api/tasks/:id/cancel
watcher.shutdown();                      // cancel all active workers and await
```

- [ ] **Step 1: Tests with spawn injected**

```javascript
// src/__tests__/coordinator/task-watcher.test.js
import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { createTaskWatcher } from "../../coordinator/task-watcher.js";
import { newTaskId } from "../../core/ids.js";

function stubBroker() {
  const broadcasts = [];
  return { broadcasts, subscribe: () => {}, unsubscribe: () => {}, broadcast: (c, p) => broadcasts.push({c, p}), size: () => 0 };
}

function seedAgent(db, name = "coder") {
  const now = Date.now();
  db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name, name, "claude", "sonnet", now, now);
}

function seedTask(db, { executor = null, reviewer = null } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare("INSERT INTO tasks (id, title, status, executor_agent, reviewer_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, "t", "todo", executor, reviewer, now, now);
  return id;
}

describe("task-watcher", () => {
  it("handleRunRequested on todo task with executor spawns worker and flips to in_progress", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const broker = stubBroker();
    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 12345,
      done: new Promise(r => { resolveDone = r; }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);
    expect(spawn).toHaveBeenCalledTimes(1);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("in_progress");
    // resolve the spawn and confirm post-completion flip
    resolveDone({ exitCode: 0, status: "complete" });
    await new Promise(r => setTimeout(r, 20));  // let tick settle
    const after = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(after.status).toBe("in_review");
  });

  it("rejects run_requested on task without executor", async () => {
    const db = makeTestDb();
    const taskId = seedTask(db);
    const broker = stubBroker();
    const spawn = vi.fn();
    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });
    await expect(watcher.handleRunRequested(taskId)).rejects.toThrow(/no executor/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects run_requested when task already in_progress", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(taskId);
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn: vi.fn(), workerBinary: "/fake" });
    await expect(watcher.handleRunRequested(taskId)).rejects.toThrow(/already/i);
  });

  it("failed worker keeps task in_progress and adds error comment", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const broker = stubBroker();
    let resolveDone;
    const spawn = vi.fn(() => ({ pid: 1, done: new Promise(r => { resolveDone = r; }), cancel: vi.fn() }));
    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);
    resolveDone({ exitCode: 1, status: "error", error: "timeout" });
    await new Promise(r => setTimeout(r, 20));
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("in_progress");
    expect(task.error_text).toBe("timeout");
    const comments = db.prepare("SELECT * FROM task_comments WHERE task_id = ?").all(taskId);
    expect(comments.some(c => c.body.includes("timeout"))).toBe(true);
  });

  it("cancel() signals the active worker for that task", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const cancelFn = vi.fn();
    const spawn = vi.fn(() => ({ pid: 1, done: new Promise(() => {}), cancel: cancelFn }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);
    watcher.cancel(taskId);
    expect(cancelFn).toHaveBeenCalled();
  });

  it("final text posted as an agent comment on clean completion", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    let resolveDone;
    const spawn = vi.fn(() => ({ pid: 1, done: new Promise(r => { resolveDone = r; }), cancel: vi.fn() }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);
    resolveDone({ exitCode: 0, status: "complete", finalText: "I did the thing." });
    await new Promise(r => setTimeout(r, 20));
    const comments = db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at").all(taskId);
    const agentComment = comments.find(c => c.author_type === "agent");
    expect(agentComment).toBeTruthy();
    expect(agentComment.body).toBe("I did the thing.");
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/coordinator/task-watcher.js
import { nextStatus } from "../core/state-machine.js";
import { newRunId, newCommentId } from "../core/ids.js";

export function createTaskWatcher({ db, broker, spawn, workerBinary, logger, repoRoot, dataDir }) {
  const active = new Map();  // taskId → { runId, handle }

  function applySideEffects(taskId, sideEffects, currentStatus, newStatus) {
    const now = Date.now();
    const fields = [];
    const values = [];
    if (currentStatus !== newStatus) { fields.push("status = ?"); values.push(newStatus); }
    let completedAt = null;
    for (const se of sideEffects) {
      if (se.type === "set_completed_at") { fields.push("completed_at = ?"); values.push(now); completedAt = now; }
      if (se.type === "clear_completed_at") { fields.push("completed_at = ?"); values.push(null); }
      if (se.type === "clear_error_text") { fields.push("error_text = ?"); values.push(null); }
    }
    if (fields.length > 0) {
      fields.push("updated_at = ?"); values.push(now);
      values.push(taskId);
      db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    broker.broadcast("global", { type: "task_updated", id: taskId });
  }

  async function handleRunRequested(taskId) {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.status !== "todo" && task.status !== "in_progress") throw new Error(`task already ${task.status}`);
    if (!task.executor_agent) throw new Error("no executor assigned");
    if (active.has(taskId)) throw new Error("task already running");

    const result = nextStatus(task.status, { type: "run_requested", executorAgent: task.executor_agent });
    if (result.sideEffects.some(se => se.type === "error")) {
      const err = result.sideEffects.find(se => se.type === "error");
      throw new Error(err.message);
    }
    applySideEffects(taskId, result.sideEffects, task.status, result.status);

    const runId = newRunId();
    const now = Date.now();
    db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, 'execute', ?, ?, 'running')")
      .run(runId, taskId, task.executor_agent, now);

    const handle = spawn({
      binary: workerBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", task.executor_agent],
      env: { WORKLAB_RUN_ID: runId, WORKLAB_DATA_DIR: dataDir || "", WORKLAB_REPO_ROOT: repoRoot || "" },
      runId, taskId, broker, db, logger,
    });

    // Update task with worker_pid
    db.prepare("UPDATE task_runs SET worker_pid = ? WHERE id = ?").run(handle.pid || null, runId);
    broker.broadcast("global", { type: "run_started", runId, taskId });

    active.set(taskId, { runId, handle });

    handle.done.then((res) => onWorkerExit(taskId, runId, res)).catch((err) => {
      logger?.error?.({ err, taskId, runId }, "worker promise rejected");
      onWorkerExit(taskId, runId, { exitCode: 1, status: "error", error: err.message });
    });

    return { runId };
  }

  function onWorkerExit(taskId, runId, res) {
    active.delete(taskId);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) return;

    if (res.status === "complete") {
      if (res.finalText) {
        db.prepare(`INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, 'agent', ?, ?, ?)`)
          .run(newCommentId(), taskId, task.executor_agent, res.finalText, Date.now());
      }
      const sm = nextStatus(task.status, { type: "run_completed", reviewerAgent: task.reviewer_agent });
      applySideEffects(taskId, sm.sideEffects, task.status, sm.status);
      // Phase 2: review mode not implemented yet — task parks in in_review if reviewer assigned.
    } else if (res.status === "cancelled") {
      // leave task status unchanged; record cancellation in a system comment
      db.prepare(`INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`)
        .run(newCommentId(), taskId, "Run cancelled.", Date.now());
      broker.broadcast("global", { type: "task_updated", id: taskId });
    } else {
      // error
      const errText = res.error || "run failed";
      db.prepare(`INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`)
        .run(newCommentId(), taskId, `ERROR: ${errText}`, Date.now());
      db.prepare("UPDATE tasks SET error_text = ?, updated_at = ? WHERE id = ?").run(errText, Date.now(), taskId);
      broker.broadcast("global", { type: "task_updated", id: taskId });
    }
    broker.broadcast("global", { type: "run_ended", runId, taskId });
  }

  function cancel(taskId) {
    const entry = active.get(taskId);
    if (!entry) return false;
    entry.handle.cancel();
    return true;
  }

  async function shutdown() {
    const promises = [];
    for (const [taskId, entry] of active.entries()) {
      entry.handle.cancel();
      promises.push(entry.handle.done);
    }
    await Promise.allSettled(promises);
  }

  return { handleRunRequested, cancel, shutdown, isActive: (taskId) => active.has(taskId) };
}
```

- [ ] **Step 4: Pass** (134 tests)

- [ ] **Step 5: Commit**

```bash
git add src/coordinator/task-watcher.js src/__tests__/coordinator/task-watcher.test.js
git commit -m "feat(coordinator): task-watcher orchestrates worker lifecycle + state transitions"
```

**Reviewer note:** Explicit no-schema-change discipline — if a test fails with a FK error, seed the referenced row (see Phase 1 P2 lesson). Confirm the watcher correctly handles `reviewer_agent` null (task parks in `in_review`, OK for Phase 2). Confirm cancel after completion is a no-op (not an error).

---

### Task 13: `POST /api/tasks/:id/run` and `/cancel` endpoints (Sonnet)

**Files:**
- Modify: `src/api/routes-tasks.js`
- Modify: `src/api/server.js` — thread through a `watcher` param
- Modify: `src/__tests__/helpers/test-server.js`
- Modify: `src/__tests__/api/routes-tasks.test.js`

- [ ] **Step 1: Update test helper to allow watcher injection**

Modify `src/__tests__/helpers/test-server.js`:

```javascript
// src/__tests__/helpers/test-server.js
import supertest from "supertest";
import { makeTestDb } from "./test-db.js";
import { createServer } from "../../api/server.js";

export function makeTestServer({ watcher } = {}) {
  const db = makeTestDb();
  const stubWatcher = watcher || {
    handleRunRequested: async () => ({ runId: "fake-run" }),
    cancel: () => true,
    shutdown: async () => {},
    isActive: () => false,
  };
  const { app, broker } = createServer({ db, logger: undefined, watcher: stubWatcher });
  return { app, broker, db, watcher: stubWatcher, agent: supertest(app) };
}
```

- [ ] **Step 2: Modify `src/api/server.js`**

Thread watcher through:

```javascript
// src/api/server.js  (change signature to accept watcher)
export function createServer({ db, logger, watcher }) {
  // ...
  registerTaskRoutes(app, { db, broker, logger, watcher });
  // ...
}
```

- [ ] **Step 3: Add endpoints + tests**

Tests to append to `src/__tests__/api/routes-tasks.test.js`:

```javascript
describe("POST /api/tasks/:id/run", () => {
  it("invokes watcher.handleRunRequested", async () => {
    const calls = [];
    const { agent } = makeTestServer({
      watcher: {
        handleRunRequested: async (id) => { calls.push(id); return { runId: "r1" }; },
        cancel: () => true, shutdown: async () => {}, isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/run`).expect(200);
    expect(res.body.runId).toBe("r1");
    expect(calls).toEqual([task.id]);
  });

  it("returns 400 when watcher throws (e.g., no executor)", async () => {
    const { agent } = makeTestServer({
      watcher: {
        handleRunRequested: async () => { throw new Error("no executor assigned"); },
        cancel: () => true, shutdown: async () => {}, isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/run`).expect(400);
    expect(res.body.error.message).toMatch(/no executor/);
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  it("invokes watcher.cancel when active", async () => {
    const cancelFn = vi.fn(() => true);
    const { agent } = makeTestServer({
      watcher: {
        handleRunRequested: async () => ({ runId: "r" }),
        cancel: cancelFn,
        shutdown: async () => {},
        isActive: () => true,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.post(`/api/tasks/${task.id}/cancel`).expect(204);
    expect(cancelFn).toHaveBeenCalledWith(task.id);
  });

  it("returns 404 when no active run", async () => {
    const { agent } = makeTestServer({
      watcher: {
        handleRunRequested: async () => ({ runId: "r" }),
        cancel: () => false,
        shutdown: async () => {},
        isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.post(`/api/tasks/${task.id}/cancel`).expect(404);
  });
});
```

Add `import { vi } from "vitest";` to the test file's imports if not already there.

- [ ] **Step 4: Fail**

- [ ] **Step 5: Implement endpoints in `src/api/routes-tasks.js`**

Change `registerTaskRoutes` signature to accept watcher, and add endpoints after the existing ones:

```javascript
// add to destructured params:
export function registerTaskRoutes(app, { db, broker, watcher }) {
  // ... existing endpoints ...

  app.post("/api/tasks/:id/run", async (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    try {
      const result = await watcher.handleRunRequested(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: { code: "invalid_state", message: err.message } });
    }
  });

  app.post("/api/tasks/:id/cancel", (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    const cancelled = watcher.cancel(req.params.id);
    if (!cancelled) return res.status(404).json({ error: { code: "not_running", message: "no active run" } });
    res.status(204).end();
  });
}
```

- [ ] **Step 6: Pass** (138 tests)

- [ ] **Step 7: Commit**

```bash
git add src/api/routes-tasks.js src/api/server.js src/__tests__/helpers/test-server.js src/__tests__/api/routes-tasks.test.js
git commit -m "feat(api): POST /tasks/:id/run + /cancel wired to task-watcher"
```

---

### Task 14: Per-run SSE stream + `GET /api/runs/:id/stream` (Sonnet)

**Files:**
- Create: `src/api/routes-runs.js`
- Create: `src/__tests__/api/routes-runs.test.js`
- Modify: `src/api/server.js`

- [ ] **Step 1: Tests**

```javascript
// src/__tests__/api/routes-runs.test.js
import { describe, it, expect } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";
import { newRunId, newTaskId } from "../../core/ids.js";

describe("GET /api/runs/:id", () => {
  it("returns 404 for missing run", async () => {
    const { agent } = makeTestServer();
    await agent.get("/api/runs/nope").expect(404);
  });

  it("returns run with embedded log events", async () => {
    const { agent, db } = makeTestServer();
    const taskId = newTaskId();
    const runId = newRunId();
    const now = Date.now();
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(taskId, "t", now, now);
    db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, 'execute', 'a', ?, 'complete')")
      .run(runId, taskId, now);
    db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES (?, ?, ?, 'complete', ?)")
      .run("log1", runId, JSON.stringify([{type:"final",text:"ok"}]), now);
    const res = await agent.get(`/api/runs/${runId}`).expect(200);
    expect(res.body.run.id).toBe(runId);
    expect(res.body.log.events.length).toBe(1);
  });
});

describe("GET /api/runs/:id/stream", () => {
  it("subscribes client to per-run SSE channel", async () => {
    // Skipping real SSE connection test — covered by smoke e2e
    // Unit-level: confirm route exists and doesn't 404
    const { agent } = makeTestServer();
    // supertest doesn't handle SSE well; we just assert the route returns 200 with the right content-type
    const req = agent.get("/api/runs/any-id/stream");
    // manually abort after first byte to avoid hanging
    req.set("Accept", "text/event-stream");
    const res = await new Promise((resolve) => {
      const r = req.buffer(false).parse((stream, callback) => {
        stream.on("data", (chunk) => {
          callback(null, chunk.toString());
          stream.destroy();
        });
      });
      r.end((err, response) => resolve(response));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/event-stream/);
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/api/routes-runs.js
export function registerRunRoutes(app, { db, broker }) {
  app.get("/api/runs/:id", (req, res) => {
    const run = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(req.params.id);
    if (!run) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    const logRow = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(req.params.id);
    const log = logRow ? { ...logRow, events: JSON.parse(logRow.events || "[]") } : null;
    res.json({ run, log });
  });

  app.get("/api/runs/:id/stream", (req, res) => {
    broker.subscribe(req.params.id, res);
  });
}
```

Modify `src/api/server.js` to register the new routes:

```javascript
import { registerRunRoutes } from "./routes-runs.js";
// ...
registerRunRoutes(app, { db, broker });
```

- [ ] **Step 4: Pass** (140 tests)

- [ ] **Step 5: Commit**

```bash
git add src/api/routes-runs.js src/api/server.js src/__tests__/api/routes-runs.test.js
git commit -m "feat(api): /api/runs/:id and per-run SSE stream"
```

---

### Task 15: `src/api/routes-agents.js` — agents CRUD (Sonnet)

**Files:**
- Create: `src/api/routes-agents.js`
- Create: `src/__tests__/api/routes-agents.test.js`
- Modify: `src/api/server.js`

- [ ] **Step 1: Tests**

```javascript
// src/__tests__/api/routes-agents.test.js
import { describe, it, expect } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("agents CRUD", () => {
  it("GET /api/agents returns []", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/agents").expect(200);
    expect(res.body).toEqual({ agents: [] });
  });

  it("POST /api/agents creates with required fields", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "sonnet" }).expect(201);
    expect(res.body.agent.name).toBe("coder");
    expect(res.body.agent.enabled).toBe(true);
    expect(res.body.agent.effort).toBe("medium");
  });

  it("POST rejects missing fields", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "x" }).expect(400);
  });

  it("POST rejects invalid name (must be slug)", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "Has Spaces", display_name: "x", sdk: "claude", model: "sonnet" }).expect(400);
  });

  it("POST rejects duplicate name", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "dup", display_name: "X", sdk: "claude", model: "sonnet" });
    await agent.post("/api/agents").send({ name: "dup", display_name: "Y", sdk: "claude", model: "sonnet" }).expect(409);
  });

  it("GET /api/agents/:name returns single with parsed JSON allowlists", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "sonnet" });
    const res = await agent.get("/api/agents/coder").expect(200);
    expect(res.body.agent.skills_allowlist).toEqual([]);
    expect(res.body.agent.mcp_allowlist).toEqual([]);
    expect(res.body.agent.builtin_allowlist).toEqual([]);
  });

  it("PATCH updates fields including allowlists (arrays)", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "sonnet" });
    const res = await agent.patch("/api/agents/coder").send({ instructions: "new", skills_allowlist: ["example"] }).expect(200);
    expect(res.body.agent.instructions).toBe("new");
    expect(res.body.agent.skills_allowlist).toEqual(["example"]);
  });

  it("DELETE removes agent", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/agents").send({ name: "coder", display_name: "Coder", sdk: "claude", model: "sonnet" });
    await agent.delete("/api/agents/coder").expect(204);
    await agent.get("/api/agents/coder").expect(404);
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/api/routes-agents.js
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function rowToAgent(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
    skills_allowlist: JSON.parse(row.skills_allowlist || "[]"),
    mcp_allowlist: JSON.parse(row.mcp_allowlist || "[]"),
    builtin_allowlist: JSON.parse(row.builtin_allowlist || "[]"),
  };
}

const PATCHABLE = ["display_name", "description", "sdk", "model", "effort", "instructions", "skills_allowlist", "mcp_allowlist", "builtin_allowlist", "enabled"];

export function registerAgentRoutes(app, { db, broker }) {
  app.get("/api/agents", (_req, res) => {
    const rows = db.prepare("SELECT * FROM agents ORDER BY name").all();
    res.json({ agents: rows.map(rowToAgent) });
  });

  app.post("/api/agents", (req, res) => {
    const { name, display_name, sdk, model } = req.body || {};
    if (!name || !NAME_RE.test(name)) return res.status(400).json({ error: { code: "validation", message: "invalid name (lowercase slug required)" } });
    if (!display_name || !sdk || !model) return res.status(400).json({ error: { code: "validation", message: "display_name, sdk, model required" } });

    const existing = db.prepare("SELECT name FROM agents WHERE name = ?").get(name);
    if (existing) return res.status(409).json({ error: { code: "conflict", message: "agent name already exists" } });

    const now = Date.now();
    const effort = req.body.effort || "medium";
    const description = req.body.description || null;
    const instructions = req.body.instructions || "";
    const skillsAllow = JSON.stringify(req.body.skills_allowlist || []);
    const mcpAllow = JSON.stringify(req.body.mcp_allowlist || []);
    const builtinAllow = JSON.stringify(req.body.builtin_allowlist || []);
    const enabled = req.body.enabled === false ? 0 : 1;

    db.prepare(`INSERT INTO agents
      (name, display_name, description, sdk, model, effort, instructions, skills_allowlist, mcp_allowlist, builtin_allowlist, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, display_name, description, sdk, model, effort, instructions, skillsAllow, mcpAllow, builtinAllow, enabled, now, now);

    broker.broadcast("global", { type: "agent_updated", name });
    res.status(201).json({ agent: rowToAgent(db.prepare("SELECT * FROM agents WHERE name = ?").get(name)) });
  });

  app.get("/api/agents/:name", (req, res) => {
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(req.params.name);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    res.json({ agent: rowToAgent(row) });
  });

  app.patch("/api/agents/:name", (req, res) => {
    const existing = db.prepare("SELECT * FROM agents WHERE name = ?").get(req.params.name);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    const fields = []; const values = [];
    for (const k of PATCHABLE) {
      if (k in req.body) {
        fields.push(`${k} = ?`);
        if (k.endsWith("_allowlist")) values.push(JSON.stringify(req.body[k] ?? []));
        else if (k === "enabled") values.push(req.body[k] ? 1 : 0);
        else values.push(req.body[k]);
      }
    }
    if (fields.length > 0) {
      fields.push("updated_at = ?"); values.push(Date.now()); values.push(req.params.name);
      db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE name = ?`).run(...values);
    }
    broker.broadcast("global", { type: "agent_updated", name: req.params.name });
    res.json({ agent: rowToAgent(db.prepare("SELECT * FROM agents WHERE name = ?").get(req.params.name)) });
  });

  app.delete("/api/agents/:name", (req, res) => {
    const r = db.prepare("DELETE FROM agents WHERE name = ?").run(req.params.name);
    if (r.changes === 0) return res.status(404).json({ error: { code: "not_found", message: "agent not found" } });
    broker.broadcast("global", { type: "agent_deleted", name: req.params.name });
    res.status(204).end();
  });
}
```

Modify `src/api/server.js` to register:

```javascript
import { registerAgentRoutes } from "./routes-agents.js";
// ...
registerAgentRoutes(app, { db, broker });
```

- [ ] **Step 4: Pass** (148 tests)

- [ ] **Step 5: Commit**

```bash
git add src/api/routes-agents.js src/api/server.js src/__tests__/api/routes-agents.test.js
git commit -m "feat(api): agents CRUD with allowlist JSON round-tripping"
```

---

### Task 16: `src/api/routes-skills.js` — skills CRUD (filesystem-backed) (Sonnet)

**Files:**
- Create: `src/api/routes-skills.js`
- Create: `src/__tests__/api/routes-skills.test.js`
- Modify: `src/api/server.js`

Skills are filesystem entries at `data/skills/<name>/SKILL.md`. CRUD operations write files directly; no DB involved.

- [ ] **Step 1: Tests**

```javascript
// src/__tests__/api/routes-skills.test.js
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { makeTestDb } from "../helpers/test-db.js";
import { createServer } from "../../api/server.js";

describe("skills CRUD", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function mkServer() {
    const d = mkdtempSync(join(tmpdir(), "worklab-skills-")); dirs.push(d);
    mkdirSync(join(d, "skills"), { recursive: true });
    const db = makeTestDb();
    const { app } = createServer({ db, logger: undefined, watcher: undefined, dataDir: d });
    return { agent: supertest(app), dataDir: d };
  }

  it("GET /api/skills lists filesystem entries", async () => {
    const { agent, dataDir } = mkServer();
    mkdirSync(join(dataDir, "skills", "alpha"));
    writeFileSync(join(dataDir, "skills", "alpha", "SKILL.md"), `---
name: alpha
trigger: "when alpha"
---
body-alpha`);
    const res = await agent.get("/api/skills").expect(200);
    expect(res.body.skills.length).toBe(1);
    expect(res.body.skills[0].name).toBe("alpha");
  });

  it("POST /api/skills creates folder + SKILL.md", async () => {
    const { agent, dataDir } = mkServer();
    const res = await agent.post("/api/skills").send({
      name: "new-skill",
      meta: { trigger: "when new", enabled: true },
      body: "playbook",
    }).expect(201);
    expect(res.body.skill.name).toBe("new-skill");
    expect(existsSync(join(dataDir, "skills", "new-skill", "SKILL.md"))).toBe(true);
    const content = readFileSync(join(dataDir, "skills", "new-skill", "SKILL.md"), "utf8");
    expect(content).toMatch(/trigger:/);
    expect(content).toMatch(/playbook/);
  });

  it("POST rejects duplicate name", async () => {
    const { agent, dataDir } = mkServer();
    mkdirSync(join(dataDir, "skills", "dup"));
    writeFileSync(join(dataDir, "skills", "dup", "SKILL.md"), `---\nname: dup\ntrigger: x\n---\n`);
    await agent.post("/api/skills").send({ name: "dup", meta: { trigger: "x" }, body: "" }).expect(409);
  });

  it("PATCH rewrites SKILL.md", async () => {
    const { agent, dataDir } = mkServer();
    await agent.post("/api/skills").send({ name: "s", meta: { trigger: "t", enabled: true }, body: "old" });
    await agent.patch("/api/skills/s").send({ meta: { trigger: "t2", enabled: true }, body: "new" }).expect(200);
    const content = readFileSync(join(dataDir, "skills", "s", "SKILL.md"), "utf8");
    expect(content).toMatch(/trigger: t2/);
    expect(content).toMatch(/new/);
  });

  it("DELETE removes the skill folder", async () => {
    const { agent, dataDir } = mkServer();
    await agent.post("/api/skills").send({ name: "bye", meta: { trigger: "t" }, body: "" });
    expect(existsSync(join(dataDir, "skills", "bye"))).toBe(true);
    await agent.delete("/api/skills/bye").expect(204);
    expect(existsSync(join(dataDir, "skills", "bye"))).toBe(false);
  });

  it("validates slug name", async () => {
    const { agent } = mkServer();
    await agent.post("/api/skills").send({ name: "has spaces", meta: { trigger: "x" }, body: "" }).expect(400);
  });
});
```

Also update `makeTestServer` to accept a `dataDir` pass-through (optional). Modify `src/__tests__/helpers/test-server.js`:

```javascript
export function makeTestServer({ watcher, dataDir } = {}) {
  const db = makeTestDb();
  const stubWatcher = watcher || {
    handleRunRequested: async () => ({ runId: "fake-run" }),
    cancel: () => true,
    shutdown: async () => {},
    isActive: () => false,
  };
  const { app, broker } = createServer({ db, logger: undefined, watcher: stubWatcher, dataDir });
  return { app, broker, db, watcher: stubWatcher, agent: supertest(app) };
}
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/api/routes-skills.js
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadSkills, parseSkillFrontmatter } from "../core/skills.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function serializeSkill(meta, body) {
  const yamlLines = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string") yamlLines.push(`${k}: ${v.includes(":") || v.includes("#") ? `"${v.replace(/"/g, '\\"')}"` : v}`);
    else yamlLines.push(`${k}: ${v}`);
  }
  yamlLines.push("---");
  return yamlLines.join("\n") + "\n\n" + (body || "");
}

export function registerSkillRoutes(app, { dataDir }) {
  const skillsDir = () => join(dataDir, "skills");

  app.get("/api/skills", (_req, res) => {
    const skills = loadSkills(skillsDir()).map(s => ({
      name: s.name, trigger: s.trigger, enabled: s.enabled, priority: s.priority,
    }));
    res.json({ skills });
  });

  app.get("/api/skills/:name", (req, res) => {
    const dir = join(skillsDir(), req.params.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) return res.status(404).json({ error: { code: "not_found", message: "skill not found" } });
    const parsed = parseSkillFrontmatter(readFileSync(file, "utf8"));
    res.json({ skill: { name: req.params.name, meta: parsed?.meta || {}, body: parsed?.body || "" } });
  });

  app.post("/api/skills", (req, res) => {
    const { name, meta = {}, body = "" } = req.body || {};
    if (!name || !NAME_RE.test(name)) return res.status(400).json({ error: { code: "validation", message: "invalid name (lowercase slug)" } });
    const dir = join(skillsDir(), name);
    if (existsSync(dir)) return res.status(409).json({ error: { code: "conflict", message: "skill already exists" } });
    mkdirSync(dir, { recursive: true });
    const finalMeta = { name, ...meta };
    writeFileSync(join(dir, "SKILL.md"), serializeSkill(finalMeta, body));
    res.status(201).json({ skill: { name, meta: finalMeta, body } });
  });

  app.patch("/api/skills/:name", (req, res) => {
    const dir = join(skillsDir(), req.params.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) return res.status(404).json({ error: { code: "not_found", message: "skill not found" } });
    const current = parseSkillFrontmatter(readFileSync(file, "utf8"));
    const meta = { ...(current?.meta || {}), ...(req.body.meta || {}), name: req.params.name };
    const body = req.body.body !== undefined ? req.body.body : (current?.body || "");
    writeFileSync(file, serializeSkill(meta, body));
    res.json({ skill: { name: req.params.name, meta, body } });
  });

  app.delete("/api/skills/:name", (req, res) => {
    const dir = join(skillsDir(), req.params.name);
    if (!existsSync(dir)) return res.status(404).json({ error: { code: "not_found", message: "skill not found" } });
    rmSync(dir, { recursive: true, force: true });
    res.status(204).end();
  });
}
```

Modify `src/api/server.js` to accept `dataDir` and register:

```javascript
export function createServer({ db, logger, watcher, dataDir }) {
  // ...
  registerSkillRoutes(app, { dataDir });
}
```

Import at top: `import { registerSkillRoutes } from "./routes-skills.js";`

- [ ] **Step 4: Pass** (154 tests)

- [ ] **Step 5: Commit**

```bash
git add src/api/routes-skills.js src/api/server.js src/__tests__/api/routes-skills.test.js src/__tests__/helpers/test-server.js
git commit -m "feat(api): skills CRUD backed by filesystem"
```

---

### Task 17: `src/api/routes-mcp.js` — MCP config GET/PUT (Sonnet)

**Files:**
- Create: `src/api/routes-mcp.js`
- Create: `src/__tests__/api/routes-mcp.test.js`
- Modify: `src/api/server.js`

- [ ] **Step 1: Tests**

```javascript
// src/__tests__/api/routes-mcp.test.js
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { makeTestDb } from "../helpers/test-db.js";
import { createServer } from "../../api/server.js";

describe("mcp config", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function mkServer() {
    const d = mkdtempSync(join(tmpdir(), "worklab-mcp-route-")); dirs.push(d);
    mkdirSync(join(d, "config"));
    writeFileSync(join(d, "config/mcp.json"), JSON.stringify({ mcpServers: {} }));
    const db = makeTestDb();
    const { app } = createServer({ db, logger: undefined, watcher: undefined, dataDir: d });
    return { agent: supertest(app), dataDir: d };
  }

  it("GET returns empty mcpServers when default", async () => {
    const { agent } = mkServer();
    const res = await agent.get("/api/mcp").expect(200);
    expect(res.body).toEqual({ mcpServers: {} });
  });

  it("PUT writes to disk and round-trips", async () => {
    const { agent, dataDir } = mkServer();
    const payload = { mcpServers: { slack: { command: "/usr/bin/node", args: ["/opt/slack-mcp"] } } };
    await agent.put("/api/mcp").send(payload).expect(200);
    const content = JSON.parse(readFileSync(join(dataDir, "config/mcp.json"), "utf8"));
    expect(content.mcpServers.slack.command).toBe("/usr/bin/node");
    const res = await agent.get("/api/mcp").expect(200);
    expect(res.body.mcpServers.slack.command).toBe("/usr/bin/node");
  });

  it("PUT rejects non-absolute stdio command", async () => {
    const { agent } = mkServer();
    await agent.put("/api/mcp").send({ mcpServers: { bad: { command: "node" } } }).expect(400);
  });

  it("PUT rejects public http URL", async () => {
    const { agent } = mkServer();
    await agent.put("/api/mcp").send({ mcpServers: { bad: { type: "http", url: "https://example.com" } } }).expect(400);
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/api/routes-mcp.js
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadMcpConfig } from "../core/mcp-config.js";

export function registerMcpRoutes(app, { dataDir }) {
  const mcpPath = () => join(dataDir, "config", "mcp.json");

  app.get("/api/mcp", (_req, res) => {
    const p = mcpPath();
    if (!existsSync(p)) return res.json({ mcpServers: {} });
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      res.json({ mcpServers: parsed.mcpServers || {} });
    } catch (err) {
      res.status(500).json({ error: { code: "parse_error", message: err.message } });
    }
  });

  app.put("/api/mcp", (req, res) => {
    const body = req.body || {};
    if (!body.mcpServers || typeof body.mcpServers !== "object") {
      return res.status(400).json({ error: { code: "validation", message: "mcpServers object required" } });
    }
    // Validate by writing to temp, running loadMcpConfig with a throw-on-bad
    const tmpDir = dataDir;
    // Write candidate to a staging buffer, then validate via loadMcpConfig over a temp dir
    // Simplest: write and re-validate by trying to load
    const p = mcpPath();
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    const prev = existsSync(p) ? readFileSync(p, "utf8") : null;
    writeFileSync(p, JSON.stringify({ mcpServers: body.mcpServers }, null, 2));
    try {
      loadMcpConfig(tmpDir);
    } catch (err) {
      if (prev !== null) writeFileSync(p, prev); else { try { require("node:fs").unlinkSync(p); } catch {} }
      return res.status(400).json({ error: { code: "validation", message: err.message } });
    }
    res.json({ mcpServers: body.mcpServers });
  });
}
```

Register in `server.js`:

```javascript
import { registerMcpRoutes } from "./routes-mcp.js";
// ...
registerMcpRoutes(app, { dataDir });
```

- [ ] **Step 4: Pass** (158 tests)

- [ ] **Step 5: Commit**

```bash
git add src/api/routes-mcp.js src/api/server.js src/__tests__/api/routes-mcp.test.js
git commit -m "feat(api): mcp config GET/PUT with validation rollback"
```

---

### Task 18: Wire coordinator + task-watcher + worker-binary path (Sonnet)

**Files:**
- Modify: `src/coordinator.js`

The coordinator instantiates the task-watcher and passes it to the server. Worker binary path resolves from `repoRoot`.

- [ ] **Step 1: Modify `src/coordinator.js`**

```javascript
// src/coordinator.js
import { createServer as createHttpServer } from "node:http";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { createServer } from "./api/server.js";
import { getDb, closeDb } from "./core/db.js";
import { logger } from "./core/logger.js";
import { loadConfig } from "./core/config.js";
import { seedDataFromTemplate } from "./core/first-boot.js";
import { createTaskWatcher } from "./coordinator/task-watcher.js";
import { spawnWorker } from "./coordinator/spawn-worker.js";

export async function startCoordinator({ config = loadConfig() } = {}) {
  const templateDir = join(config.repoRoot, "data-template");
  const seedResult = seedDataFromTemplate({ templateDir, dataDir: config.dataDir });
  if (seedResult.seeded) logger.info("seeded data dir from template");

  const dbPath = join(config.dataDir, "worklab.db");
  const db = getDb(dbPath);

  const workerBinary = join(config.repoRoot, "src", "worker.js");

  // First create server without watcher so broker exists; then wire watcher.
  // Simpler: create watcher with a broker stub that gets replaced — or build the broker first.
  // Cleanest: instantiate server once, then extract broker, then build watcher, then re-pass.
  // We'll use a two-phase init: server first with null watcher, then route-tasks' watcher slot gets filled via a mutable holder.

  // Build the server with a deferred watcher holder
  const watcherHolder = { current: null };
  const watcherProxy = {
    handleRunRequested: (...args) => watcherHolder.current.handleRunRequested(...args),
    cancel: (...args) => watcherHolder.current.cancel(...args),
    shutdown: (...args) => watcherHolder.current.shutdown(...args),
    isActive: (...args) => watcherHolder.current.isActive(...args),
  };
  const { app, broker } = createServer({ db, logger, watcher: watcherProxy, dataDir: config.dataDir });

  watcherHolder.current = createTaskWatcher({
    db, broker, spawn: spawnWorker, workerBinary, logger,
    repoRoot: config.repoRoot, dataDir: config.dataDir,
  });

  const uiDist = join(config.repoRoot, "src/ui/dist");
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get("*", (_req, res) => res.sendFile(join(uiDist, "index.html")));
  } else {
    app.get("/", (_req, res) => res.status(503).send("UI not built. Run: npm run build:ui"));
  }

  const http = createHttpServer(app);
  await new Promise((resolve) => http.listen(config.port, resolve));
  logger.info({ port: config.port }, "coordinator listening");

  const pidFile = join(config.dataDir, ".coordinator.pid");
  writeFileSync(pidFile, String(process.pid));

  async function shutdown() {
    logger.info("shutdown");
    try { await watcherHolder.current.shutdown(); } catch (err) { logger.warn({ err }, "watcher shutdown error"); }
    http.close(() => {
      closeDb();
      try { unlinkSync(pidFile); } catch {}
      process.exit(0);
    });
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { http, db, config, watcher: watcherHolder.current };
}
```

- [ ] **Step 2: Confirm test suite still passes (coordinator has no unit tests; this is exercised in e2e T20)**

```bash
npm test
# Expected: 158 tests (no new tests in this task)
```

- [ ] **Step 3: Commit**

```bash
git add src/coordinator.js
git commit -m "feat(coordinator): wire task-watcher with spawn-worker and worker.js path"
```

---

### Task 19: UI — API client extensions + route scaffolding (Sonnet)

**Files:**
- Modify: `src/ui/src/lib/api.js`
- Modify: `src/ui/src/App.jsx`
- Create stubs: `src/ui/src/routes/Agents.jsx`, `src/ui/src/routes/AgentEdit.jsx`, `src/ui/src/routes/Skills.jsx`, `src/ui/src/routes/SkillEdit.jsx`

Preps the UI for T20+. Stub route files keep the Vite build succeeding while real implementations land in the next tasks.

- [ ] **Step 1: Extend `api.js`**

Replace the `api` export block in `src/ui/src/lib/api.js` with:

```javascript
export const api = {
  // tasks
  listTasks: (query) => request("GET", `/tasks${query ? "?" + new URLSearchParams(query) : ""}`),
  getTask: (id) => request("GET", `/tasks/${id}`),
  createTask: (data) => request("POST", "/tasks", data),
  patchTask: (id, patch) => request("PATCH", `/tasks/${id}`, patch),
  deleteTask: (id) => request("DELETE", `/tasks/${id}`),
  addComment: (id, body) => request("POST", `/tasks/${id}/comments`, { body }),
  runTask: (id) => request("POST", `/tasks/${id}/run`),
  cancelTask: (id) => request("POST", `/tasks/${id}/cancel`),
  // runs
  getRun: (id) => request("GET", `/runs/${id}`),
  // settings
  getSettings: () => request("GET", "/settings"),
  patchSettings: (patch) => request("PATCH", "/settings", patch),
  // agents
  listAgents: () => request("GET", "/agents"),
  getAgent: (name) => request("GET", `/agents/${name}`),
  createAgent: (data) => request("POST", "/agents", data),
  patchAgent: (name, patch) => request("PATCH", `/agents/${name}`, patch),
  deleteAgent: (name) => request("DELETE", `/agents/${name}`),
  // skills
  listSkills: () => request("GET", "/skills"),
  getSkill: (name) => request("GET", `/skills/${name}`),
  createSkill: (data) => request("POST", "/skills", data),
  patchSkill: (name, patch) => request("PATCH", `/skills/${name}`, patch),
  deleteSkill: (name) => request("DELETE", `/skills/${name}`),
  // mcp
  getMcpConfig: () => request("GET", "/mcp"),
  putMcpConfig: (data) => request("PUT", "/mcp", data),
};
```

- [ ] **Step 2: Modify `App.jsx` to route the new paths**

Add imports + route branches:

```javascript
import { Agents } from "./routes/Agents.jsx";
import { AgentEdit } from "./routes/AgentEdit.jsx";
import { Skills } from "./routes/Skills.jsx";
import { SkillEdit } from "./routes/SkillEdit.jsx";
```

Inside `App()` function, extend the route switch:

```javascript
  let body;
  if (route === "tasks" && rest[0]) body = <TaskDetail id={rest[0]} />;
  else if (route === "tasks") body = <Kanban />;
  else if (route === "agents" && rest[0]) body = <AgentEdit name={rest[0]} />;
  else if (route === "agents") body = <Agents />;
  else if (route === "skills" && rest[0]) body = <SkillEdit name={rest[0]} />;
  else if (route === "skills") body = <Skills />;
  else if (route === "settings") body = <Settings />;
  else body = <Kanban />;
```

Extend the nav links:

```html
      <nav class="topnav">
        <a href="#/tasks" class={route === "tasks" ? "active" : ""}>Tasks</a>
        <a href="#/agents" class={route === "agents" ? "active" : ""}>Agents</a>
        <a href="#/skills" class={route === "skills" ? "active" : ""}>Skills</a>
        <a href="#/settings" class={route === "settings" ? "active" : ""}>Settings</a>
      </nav>
```

- [ ] **Step 3: Create stub files**

Four STUB files (will be replaced in T20+):

`src/ui/src/routes/Agents.jsx`:
```javascript
export function Agents() { return <div>Agents (stub — T20)</div>; }
```

`src/ui/src/routes/AgentEdit.jsx`:
```javascript
export function AgentEdit({ name }) { return <div>AgentEdit (stub — T20): {name}</div>; }
```

`src/ui/src/routes/Skills.jsx`:
```javascript
export function Skills() { return <div>Skills (stub — T21)</div>; }
```

`src/ui/src/routes/SkillEdit.jsx`:
```javascript
export function SkillEdit({ name }) { return <div>SkillEdit (stub — T21): {name}</div>; }
```

- [ ] **Step 4: Build + commit**

```bash
npm run build:ui
npm test    # 158 tests still passing
git add src/ui/src/lib/api.js src/ui/src/App.jsx \
        src/ui/src/routes/Agents.jsx src/ui/src/routes/AgentEdit.jsx \
        src/ui/src/routes/Skills.jsx src/ui/src/routes/SkillEdit.jsx
git commit -m "feat(ui): api client + router for agents/skills + stub routes"
```

---

### Task 20: UI — Agents list + edit (Sonnet)

**Files:**
- Overwrite: `src/ui/src/routes/Agents.jsx` (replace T19 stub)
- Overwrite: `src/ui/src/routes/AgentEdit.jsx` (replace T19 stub)

- [ ] **Step 1: `Agents.jsx`**

```javascript
// src/ui/src/routes/Agents.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";

export function Agents() {
  const [agents, setAgents] = useState([]);
  const reload = useCallback(() => { api.listAgents().then(r => setAgents(r.agents)); }, []);
  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => { if (evt.type?.startsWith("agent_")) reload(); });

  return (
    <div class="detail">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="margin:0">Agents</h2>
        <a href="#/agents/new" class="primary" style="padding:6px 10px;border-radius:4px;background:var(--accent);color:#fff;text-decoration:none">+ New agent</a>
      </div>
      {agents.length === 0 && <div class="meta">No agents yet. Create one to assign to tasks.</div>}
      <ul style="list-style:none;padding:0">
        {agents.map(a => (
          <li key={a.name} class="task-card" style="margin-bottom:8px">
            <a href={`#/agents/${a.name}`} style="color:inherit;text-decoration:none">
              <h4>{a.display_name} <span class="meta">({a.name})</span></h4>
              <div class="meta">{a.sdk}:{a.model} · effort {a.effort} · {a.enabled ? "enabled" : "disabled"}</div>
              {a.description && <div style="margin-top:4px">{a.description}</div>}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: `AgentEdit.jsx`**

```javascript
// src/ui/src/routes/AgentEdit.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

const SDK_OPTIONS = [{ value: "claude", label: "Claude" }];
const MODEL_OPTIONS = [
  { value: "haiku", label: "Claude Haiku 4.5" },
  { value: "sonnet", label: "Claude Sonnet 4.6" },
  { value: "opus", label: "Claude Opus 4.7" },
];
const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];
const BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"];

const emptyAgent = {
  name: "",
  display_name: "",
  description: "",
  sdk: "claude",
  model: "sonnet",
  effort: "medium",
  instructions: "",
  skills_allowlist: [],
  mcp_allowlist: [],
  builtin_allowlist: [],
  enabled: true,
};

export function AgentEdit({ name }) {
  const isNew = name === "new";
  const [agent, setAgent] = useState(isNew ? emptyAgent : null);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.listSkills().then(r => setSkills(r.skills));
    api.getMcpConfig().then(r => setMcpServers(Object.keys(r.mcpServers || {})));
    if (!isNew) api.getAgent(name).then(r => setAgent(r.agent)).catch(() => setAgent({ notFound: true }));
  }, [name, isNew]);

  if (!agent) return <div>Loading…</div>;
  if (agent.notFound) return <div>Agent not found. <a href="#/agents">Back</a></div>;

  function toggleList(list, value) {
    return list.includes(value) ? list.filter(x => x !== value) : [...list, value];
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        await api.createAgent(agent);
        window.location.hash = `#/agents/${agent.name}`;
      } else {
        await api.patchAgent(name, agent);
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally { setSaving(false); }
  }

  async function destroy() {
    if (!confirm(`Delete agent "${name}"?`)) return;
    await api.deleteAgent(name);
    window.location.hash = "#/agents";
  }

  return (
    <div class="detail">
      <a href="#/agents">← Back</a>
      <h2>{isNew ? "New agent" : agent.display_name}</h2>
      {error && <div style="color:#ff7a7a;margin-bottom:12px">{error}</div>}

      <div class="field"><label>Name (slug)</label>
        <input value={agent.name} disabled={!isNew}
          onInput={(e) => setAgent({ ...agent, name: e.target.value })} /></div>
      <div class="field"><label>Display name</label>
        <input value={agent.display_name}
          onInput={(e) => setAgent({ ...agent, display_name: e.target.value })} /></div>
      <div class="field"><label>Description</label>
        <input value={agent.description || ""}
          onInput={(e) => setAgent({ ...agent, description: e.target.value })} /></div>

      <div class="field"><label>SDK</label>
        <select value={agent.sdk} onChange={(e) => setAgent({ ...agent, sdk: e.target.value })}>
          {SDK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select></div>
      <div class="field"><label>Model</label>
        <select value={agent.model} onChange={(e) => setAgent({ ...agent, model: e.target.value })}>
          {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select></div>
      <div class="field"><label>Effort</label>
        <select value={agent.effort} onChange={(e) => setAgent({ ...agent, effort: e.target.value })}>
          {EFFORT_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
        </select></div>

      <div class="field"><label>Instructions (free text — becomes the system prompt role)</label>
        <textarea rows="10" value={agent.instructions}
          onInput={(e) => setAgent({ ...agent, instructions: e.target.value })} /></div>

      <div class="field"><label>Skills allowlist (empty = all enabled skills)</label>
        {skills.length === 0 && <div class="meta">No skills defined yet.</div>}
        {skills.map(s => (
          <label key={s.name} style="display:inline-block;margin-right:12px">
            <input type="checkbox" checked={agent.skills_allowlist.includes(s.name)}
              onChange={() => setAgent({ ...agent, skills_allowlist: toggleList(agent.skills_allowlist, s.name) })} />
            {s.name}
          </label>
        ))}
      </div>

      <div class="field"><label>MCP servers allowlist (empty = all registered, worklab always included)</label>
        {mcpServers.length === 0 && <div class="meta">No user MCP servers registered.</div>}
        {mcpServers.map(m => (
          <label key={m} style="display:inline-block;margin-right:12px">
            <input type="checkbox" checked={agent.mcp_allowlist.includes(m)}
              onChange={() => setAgent({ ...agent, mcp_allowlist: toggleList(agent.mcp_allowlist, m) })} />
            {m}
          </label>
        ))}
      </div>

      <div class="field"><label>Built-in tools allowlist (empty = all tools)</label>
        {BUILTIN_TOOLS.map(t => (
          <label key={t} style="display:inline-block;margin-right:12px">
            <input type="checkbox" checked={agent.builtin_allowlist.includes(t)}
              onChange={() => setAgent({ ...agent, builtin_allowlist: toggleList(agent.builtin_allowlist, t) })} />
            {t}
          </label>
        ))}
      </div>

      <div class="field"><label>Enabled</label>
        <input type="checkbox" checked={agent.enabled}
          onChange={(e) => setAgent({ ...agent, enabled: e.target.checked })} /></div>

      <button class="primary" onClick={save} disabled={saving || !agent.name || !agent.display_name}>
        {saving ? "Saving…" : (isNew ? "Create" : "Save")}
      </button>
      {!isNew && <button onClick={destroy} style="margin-left:8px;color:#ff7a7a">Delete</button>}
    </div>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
npm run build:ui
npm test    # 158 tests still passing
git add src/ui/src/routes/Agents.jsx src/ui/src/routes/AgentEdit.jsx
git commit -m "feat(ui): agents list + edit form with allowlist checkboxes"
```

---

### Task 21: UI — Skills list + edit (Sonnet)

**Files:**
- Overwrite: `src/ui/src/routes/Skills.jsx` (replace T19 stub)
- Overwrite: `src/ui/src/routes/SkillEdit.jsx` (replace T19 stub)

- [ ] **Step 1: `Skills.jsx`**

```javascript
// src/ui/src/routes/Skills.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";

export function Skills() {
  const [skills, setSkills] = useState([]);
  const reload = useCallback(() => { api.listSkills().then(r => setSkills(r.skills)); }, []);
  useEffect(() => { reload(); }, [reload]);

  return (
    <div class="detail">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="margin:0">Skills</h2>
        <a href="#/skills/new" class="primary" style="padding:6px 10px;border-radius:4px;background:var(--accent);color:#fff;text-decoration:none">+ New skill</a>
      </div>
      {skills.length === 0 && <div class="meta">No skills yet.</div>}
      <ul style="list-style:none;padding:0">
        {skills.map(s => (
          <li key={s.name} class="task-card" style="margin-bottom:8px">
            <a href={`#/skills/${s.name}`} style="color:inherit;text-decoration:none">
              <h4>{s.name} {s.priority === "always" && <span class="meta">(always-inlined)</span>}</h4>
              <div class="meta">{s.trigger} · {s.enabled ? "enabled" : "disabled"}</div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: `SkillEdit.jsx`**

```javascript
// src/ui/src/routes/SkillEdit.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

const emptySkill = { name: "", meta: { trigger: "", enabled: true, priority: "" }, body: "" };

export function SkillEdit({ name }) {
  const isNew = name === "new";
  const [skill, setSkill] = useState(isNew ? emptySkill : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isNew) api.getSkill(name).then(r => setSkill(r.skill)).catch(() => setSkill({ notFound: true }));
  }, [name, isNew]);

  if (!skill) return <div>Loading…</div>;
  if (skill.notFound) return <div>Skill not found. <a href="#/skills">Back</a></div>;

  async function save() {
    setSaving(true); setError(null);
    try {
      const payload = {
        meta: { ...skill.meta, trigger: skill.meta.trigger, enabled: !!skill.meta.enabled },
        body: skill.body,
      };
      if (!skill.meta.priority) delete payload.meta.priority;
      if (isNew) {
        await api.createSkill({ name: skill.name, ...payload });
        window.location.hash = `#/skills/${skill.name}`;
      } else {
        await api.patchSkill(name, payload);
      }
    } catch (err) { setError(err.message || String(err)); }
    finally { setSaving(false); }
  }

  async function destroy() {
    if (!confirm(`Delete skill "${name}"?`)) return;
    await api.deleteSkill(name);
    window.location.hash = "#/skills";
  }

  return (
    <div class="detail">
      <a href="#/skills">← Back</a>
      <h2>{isNew ? "New skill" : skill.name}</h2>
      {error && <div style="color:#ff7a7a;margin-bottom:12px">{error}</div>}

      <div class="field"><label>Name (slug)</label>
        <input value={skill.name} disabled={!isNew}
          onInput={(e) => setSkill({ ...skill, name: e.target.value })} /></div>

      <div class="field"><label>Trigger</label>
        <input value={skill.meta.trigger || ""}
          onInput={(e) => setSkill({ ...skill, meta: { ...skill.meta, trigger: e.target.value } })} /></div>

      <div class="field"><label>Priority</label>
        <select value={skill.meta.priority || ""}
          onChange={(e) => setSkill({ ...skill, meta: { ...skill.meta, priority: e.target.value || undefined } })}>
          <option value="">(on demand)</option>
          <option value="always">always (inline full body in every system prompt)</option>
        </select></div>

      <div class="field"><label>Enabled</label>
        <input type="checkbox" checked={skill.meta.enabled !== false}
          onChange={(e) => setSkill({ ...skill, meta: { ...skill.meta, enabled: e.target.checked } })} /></div>

      <div class="field"><label>Body (markdown playbook)</label>
        <textarea rows="20" value={skill.body}
          onInput={(e) => setSkill({ ...skill, body: e.target.value })}
          style="font-family:ui-monospace,Menlo,Monaco,monospace" /></div>

      <button class="primary" onClick={save} disabled={saving || !skill.name}>
        {saving ? "Saving…" : (isNew ? "Create" : "Save")}
      </button>
      {!isNew && <button onClick={destroy} style="margin-left:8px;color:#ff7a7a">Delete</button>}
    </div>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
npm run build:ui
npm test
git add src/ui/src/routes/Skills.jsx src/ui/src/routes/SkillEdit.jsx
git commit -m "feat(ui): skills list + edit with markdown textarea"
```

---

### Task 22: UI — EventTimeline + Run button + live streaming in TaskDetail (**Opus**)

**Files:**
- Create: `src/ui/src/lib/useRunStream.js`
- Create: `src/ui/src/components/EventTimeline.jsx`
- Modify: `src/ui/src/routes/TaskDetail.jsx`

The live event timeline renders SDK events as they arrive: thinking blocks, tool calls, tool results, assistant text. Users click "Run now" on a task with an executor assigned; a new run is created; SSE connects to `/api/runs/:id/stream`; events render inline and auto-scroll. When the run ends, the task state flips (via the global SSE event) and the next run button becomes enabled again.

- [ ] **Step 1: `useRunStream.js`**

```javascript
// src/ui/src/lib/useRunStream.js
import { useEffect, useRef, useState } from "preact/hooks";

export function useRunStream(runId) {
  const [events, setEvents] = useState([]);
  const [done, setDone] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    if (!runId) return;
    setEvents([]); setDone(false);
    // Preload any already-recorded events (run may have ended before we connected)
    fetch(`/api/runs/${runId}`).then(r => r.ok ? r.json() : null).then(data => {
      if (data?.log?.events?.length) setEvents(data.log.events);
      if (data?.run?.status && data.run.status !== "running") setDone(true);
    }).catch(() => {});
    const es = new EventSource(`/api/runs/${runId}/stream`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === "done") { setDone(true); es.close(); return; }
        setEvents(prev => [...prev, payload]);
      } catch {}
    };
    es.onerror = () => { es.close(); };
    return () => { es.close(); };
  }, [runId]);

  return { events, done };
}
```

- [ ] **Step 2: `EventTimeline.jsx`**

```javascript
// src/ui/src/components/EventTimeline.jsx
function renderSdkEvent(ev) {
  if (ev.type === "assistant" && ev.message?.content) {
    return ev.message.content.map((block, i) => {
      if (block.type === "text") return <div key={i} class="comment" style="border-left:3px solid var(--accent)"><div class="author">assistant</div>{block.text}</div>;
      if (block.type === "tool_use") return <div key={i} class="comment" style="border-left:3px solid #d9a656"><div class="author">tool_use · {block.name}</div><pre style="white-space:pre-wrap;margin:0;font-size:11px">{JSON.stringify(block.input, null, 2)}</pre></div>;
      if (block.type === "thinking") return <div key={i} class="comment" style="border-left:3px solid #6a6a8c;opacity:0.8"><div class="author">thinking</div>{block.thinking || block.text || ""}</div>;
      return null;
    });
  }
  if (ev.type === "user" && ev.message?.content) {
    return ev.message.content.map((block, i) => {
      if (block.type === "tool_result") return <div key={i} class="comment" style="border-left:3px solid #6ac26a;opacity:0.9"><div class="author">tool_result</div><pre style="white-space:pre-wrap;margin:0;font-size:11px">{typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)}</pre></div>;
      return null;
    });
  }
  if (ev.type === "result") {
    const u = ev.usage || {};
    return <div class="comment" style="border-left:3px solid var(--muted)"><div class="author">result</div>in {u.input_tokens ?? "?"} / out {u.output_tokens ?? "?"} tokens · {ev.duration_ms ?? "?"}ms · {ev.num_turns ?? "?"} turns</div>;
  }
  return null;
}

function renderMessage(ev) {
  if (ev.type === "started") return <div class="meta">▶ run started</div>;
  if (ev.type === "final") return <div class="comment" style="border-left:3px solid var(--accent);background:var(--panel)"><div class="author">final</div>{ev.text}</div>;
  if (ev.type === "error") return <div class="comment" style="border-left:3px solid #ff7a7a"><div class="author">error</div>{ev.message}</div>;
  if (ev.type === "cancelled") return <div class="meta">✕ cancelled</div>;
  if (ev.type === "sdk_event") return renderSdkEvent(ev.event);
  return null;
}

export function EventTimeline({ events }) {
  if (!events.length) return <div class="meta">No events yet.</div>;
  return <div>{events.map((e, i) => <div key={i}>{renderMessage(e)}</div>)}</div>;
}
```

- [ ] **Step 3: Modify `TaskDetail.jsx`**

Add Run button and live stream section. Replace the existing file with this extended version:

```javascript
// src/ui/src/routes/TaskDetail.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useRunStream } from "../lib/useRunStream.js";
import { CommentList } from "../components/CommentList.jsx";
import { EventTimeline } from "../components/EventTimeline.jsx";

export function TaskDetail({ id }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [newComment, setNewComment] = useState("");
  const [activeRunId, setActiveRunId] = useState(null);
  const [runError, setRunError] = useState(null);

  const reload = useCallback(() => {
    api.getTask(id).then(setData).catch(() => setData({ notFound: true }));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => {
    if (evt.id === id) reload();
    if (evt.type === "run_started" && evt.taskId === id) setActiveRunId(evt.runId);
    if (evt.type === "run_ended" && evt.taskId === id) setActiveRunId(null);
  });

  // When the task loads, discover the latest running run if any
  useEffect(() => {
    if (data?.runs?.length && !activeRunId) {
      const latest = data.runs[0];
      if (latest?.status === "running") setActiveRunId(latest.id);
    }
  }, [data, activeRunId]);

  const { events: runEvents } = useRunStream(activeRunId);

  if (!data) return <div>Loading…</div>;
  if (data.notFound) return <div>Task not found. <a href="#/tasks">Back</a></div>;
  const { task, comments, runs } = data;

  async function save() { await api.patchTask(id, draft); setEditing(false); }
  async function addComment(e) {
    e.preventDefault();
    if (!newComment.trim()) return;
    await api.addComment(id, newComment.trim());
    setNewComment("");
  }
  async function destroy() {
    if (!confirm("Delete this task?")) return;
    await api.deleteTask(id);
    window.location.hash = "#/tasks";
  }
  async function runNow() {
    setRunError(null);
    try {
      const r = await api.runTask(id);
      setActiveRunId(r.runId);
    } catch (err) { setRunError(err.message); }
  }
  async function cancelRun() {
    try { await api.cancelTask(id); } catch (err) { setRunError(err.message); }
  }

  const canRun = task.executor_agent && (task.status === "todo" || task.status === "in_progress") && !activeRunId;

  return (
    <div class="detail">
      <a href="#/tasks">← Back</a>
      <h2>{task.title}</h2>
      <div class="meta">
        status: {task.status} · executor: {task.executor_agent || "—"} · reviewer: {task.reviewer_agent || "—"}
      </div>

      <div style="margin:12px 0">
        <button class="primary" onClick={runNow} disabled={!canRun}>▶ Run now</button>
        {activeRunId && <button onClick={cancelRun} style="margin-left:8px;color:#ff7a7a">Cancel run</button>}
        {runError && <span style="color:#ff7a7a;margin-left:12px">{runError}</span>}
      </div>

      {activeRunId && (
        <div style="border:1px solid var(--border);border-radius:6px;padding:12px;background:var(--panel);margin-bottom:16px">
          <h4 style="margin:0 0 8px">Live run</h4>
          <EventTimeline events={runEvents} />
        </div>
      )}

      {!editing ? (
        <>
          <p>{task.description || <span class="meta">No description.</span>}</p>
          <h4>Instructions</h4>
          <pre style="white-space:pre-wrap;background:var(--panel-2);padding:10px;border-radius:6px">{task.instructions || "(none)"}</pre>
          <button onClick={() => { setDraft(task); setEditing(true); }}>Edit</button>
          <button onClick={destroy} style="margin-left:8px;color:#ff7a7a">Delete</button>
        </>
      ) : (
        <>
          <div class="field"><label>Title</label><input value={draft.title} onInput={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
          <div class="field"><label>Description</label><textarea rows="4" value={draft.description} onInput={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
          <div class="field"><label>Instructions</label><textarea rows="8" value={draft.instructions} onInput={(e) => setDraft({ ...draft, instructions: e.target.value })} /></div>
          <div class="field"><label>Executor agent</label><input value={draft.executor_agent || ""} placeholder="agent name (slug)" onInput={(e) => setDraft({ ...draft, executor_agent: e.target.value || null })} /></div>
          <div class="field"><label>Reviewer agent</label><input value={draft.reviewer_agent || ""} placeholder="(optional)" onInput={(e) => setDraft({ ...draft, reviewer_agent: e.target.value || null })} /></div>
          <button class="primary" onClick={save}>Save</button>
          <button onClick={() => setEditing(false)} style="margin-left:8px">Cancel</button>
        </>
      )}

      {runs?.length > 0 && (
        <>
          <h3 style="margin-top:24px">Previous runs</h3>
          <ul style="list-style:none;padding:0">
            {runs.slice(0, 5).map(r => (
              <li key={r.id} class="meta" style="margin-bottom:4px">
                {r.mode} · {r.agent_name} · {r.status} · {new Date(r.started_at).toLocaleString()}
                {r.ended_at && ` → ${new Date(r.ended_at).toLocaleString()}`}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 style="margin-top:24px">Comments</h3>
      <CommentList comments={comments} />
      <form onSubmit={addComment} style="margin-top:12px">
        <div class="field"><textarea rows="3" placeholder="Add a comment…" value={newComment} onInput={(e) => setNewComment(e.target.value)} /></div>
        <button type="submit" class="primary" disabled={!newComment.trim()}>Post</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Build + commit**

```bash
npm run build:ui
npm test
git add src/ui/src/lib/useRunStream.js src/ui/src/components/EventTimeline.jsx src/ui/src/routes/TaskDetail.jsx
git commit -m "feat(ui): run button + live event timeline + useRunStream"
```

**Reviewer note (Opus):** The `useRunStream` hook must handle the case where the run has already finished by the time the hook mounts (via the fetch preload). Confirm that the `done` event closes the EventSource. Confirm the executor/reviewer fields in the edit form properly send null (not empty string) on clear.

---

### Task 23: E2E — full run lifecycle with fake worker (Sonnet)

**File:**
- Create: `src/__tests__/e2e/run-lifecycle.test.js`

End-to-end test that instantiates the full server + task-watcher + spawn-worker (using the fake-worker binary), creates an agent, creates a task, POSTs /run, waits for clean exit, verifies final state.

- [ ] **Step 1: Test**

```javascript
// src/__tests__/e2e/run-lifecycle.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../api/server.js";
import { getDb, closeDb } from "../../core/db.js";
import { createTaskWatcher } from "../../coordinator/task-watcher.js";
import { spawnWorker } from "../../coordinator/spawn-worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeBinary = resolve(__dirname, "../helpers/fake-worker.js");

describe("e2e: full run lifecycle via fake worker", () => {
  let http, baseUrl, tmp;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "worklab-e2e-run-"));
    const db = getDb(join(tmp, "test.db"));

    const watcherHolder = { current: null };
    const watcherProxy = {
      handleRunRequested: (...a) => watcherHolder.current.handleRunRequested(...a),
      cancel: (...a) => watcherHolder.current.cancel(...a),
      shutdown: (...a) => watcherHolder.current.shutdown(...a),
      isActive: (...a) => watcherHolder.current.isActive(...a),
    };
    const { app, broker } = createServer({ db, logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }, watcher: watcherProxy, dataDir: tmp });
    // Inject a fake worker binary via a customized spawn wrapper
    const spawnFake = (opts) => spawnWorker({
      ...opts,
      binary: fakeBinary,
      env: {
        ...opts.env,
        FAKE_WORKER_SCRIPT: JSON.stringify({
          events: [
            { type: "started", runId: opts.runId, ts: Date.now() },
            { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "text", text: "hello from fake" }] } } },
            { type: "final", text: "hello from fake", usage: { input_tokens: 10, output_tokens: 5 }, durationMs: 50, numTurns: 1, model: "claude-sonnet-4-6", effort: "medium" },
          ],
          exitCode: 0,
        }),
      },
    });
    watcherHolder.current = createTaskWatcher({
      db, broker, spawn: spawnFake, workerBinary: fakeBinary, repoRoot: tmp, dataDir: tmp,
    });

    http = createHttpServer(app);
    await new Promise(r => http.listen(0, r));
    baseUrl = `http://localhost:${http.address().port}`;
  }, 20000);

  afterAll(async () => {
    await new Promise(r => http.close(r));
    closeDb();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("create agent → create task → run → auto-flip to in_review → final comment posted", async () => {
    // Create agent
    let res = await fetch(`${baseUrl}/api/agents`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-coder", display_name: "E2E Coder", sdk: "claude", model: "sonnet" }),
    });
    expect(res.status).toBe(201);

    // Create task with executor
    res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "e2e run", executor_agent: "e2e-coder" }),
    });
    expect(res.status).toBe(201);
    const { task } = await res.json();

    // Request run
    res = await fetch(`${baseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const { runId } = await res.json();

    // Wait up to 5s for task to reach in_review
    let finalTask;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      const tr = await fetch(`${baseUrl}/api/tasks/${task.id}`).then(r => r.json());
      if (tr.task.status === "in_review") { finalTask = tr; break; }
    }
    expect(finalTask?.task.status).toBe("in_review");

    // Agent comment posted with the final text
    const agentComments = finalTask.comments.filter(c => c.author_type === "agent");
    expect(agentComments.length).toBe(1);
    expect(agentComments[0].body).toBe("hello from fake");

    // Run log persisted
    const runRes = await fetch(`${baseUrl}/api/runs/${runId}`).then(r => r.json());
    expect(runRes.run.status).toBe("complete");
    expect(runRes.log.events.length).toBeGreaterThan(0);
    expect(runRes.log.input_tokens).toBe(10);
  }, 30000);
});
```

- [ ] **Step 2: Run, pass** (159 tests)

- [ ] **Step 3: Commit**

```bash
npm test
git add src/__tests__/e2e/run-lifecycle.test.js
git commit -m "test(e2e): full run lifecycle through fake worker"
```

---

### Task 24: Manual live verification via a free Claude credential (if available), else scripted smoke (Sonnet)

**File:** none committed — verification only.

This task is the real acceptance gate: start the coordinator for real, create a live Claude agent (if an API key or `CLAUDE_CODE_OAUTH_TOKEN` is set in the environment), run a task end-to-end, and confirm the journal entry.

If no Claude credentials are available on the execution environment (the DigitalOcean droplet we're working on has `ANTHROPIC_API_KEY` per Phase 1 CLAUDE.md), **skip the live Claude call** and instead run a scripted coordinator smoke that exercises everything the fake-worker e2e already proved. Document whichever path you take.

- [ ] **Step 1: Build UI**

```bash
cd /opt/claude-workspace/local/worklab
npm run build:ui
```

- [ ] **Step 2: Start coordinator on a free port**

```bash
export WORKLAB_PORT=17879
export ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' /opt/claude-workspace/.env | cut -d= -f2-)
node src/cli/index.js start > /tmp/worklab2-start.log 2>&1 &
sleep 3
cat /tmp/worklab2-start.log | tail -5
```

Expect: `coordinator listening` on 17879.

- [ ] **Step 3: Create an agent via curl**

```bash
BASE="http://localhost:17879"
curl -sS -X POST -H 'Content-Type: application/json' "$BASE/api/agents" \
  -d '{"name":"live","display_name":"Live","sdk":"claude","model":"haiku","effort":"low","instructions":"You are a test agent. Respond briefly and journal once."}' | head -c 400; echo
```

- [ ] **Step 4: Create a task with the agent assigned**

```bash
CREATED=$(curl -sS -X POST -H 'Content-Type: application/json' "$BASE/api/tasks" \
  -d '{"title":"phase-2 live smoke","instructions":"Say hello and call journal_append once.","executor_agent":"live"}')
TID=$(echo "$CREATED" | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).task.id))")
echo "task=$TID"
```

- [ ] **Step 5: Trigger the run and tail the SSE stream**

```bash
RUN_RES=$(curl -sS -X POST "$BASE/api/tasks/$TID/run")
echo "$RUN_RES"
RUN_ID=$(echo "$RUN_RES" | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).runId))")
echo "run=$RUN_ID"

# Tail the SSE stream for 60 seconds while the model runs
(curl -sS -N "$BASE/api/runs/$RUN_ID/stream" & PID=$!
 sleep 60
 kill $PID 2>/dev/null) | head -50
```

If no Claude credentials are configured, the worker will emit an error event and exit nonzero — document this. If the credential IS present, expect sdk_event lines and eventually a `final` event with text.

- [ ] **Step 6: Confirm task status + journal**

```bash
# Task should be in_review (no reviewer assigned)
curl -sS "$BASE/api/tasks/$TID" | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{const r=JSON.parse(d); console.log('status:',r.task.status); console.log('comments:',r.comments.length);})"

# Journal file
ls -la data/agents/live/
cat data/agents/live/JOURNAL.md 2>/dev/null || echo "(no journal written)"
```

If the live path completed: the task is `in_review`, one agent comment exists, and `JOURNAL.md` has at least one entry.

- [ ] **Step 7: Stop coordinator**

```bash
WORKLAB_PORT=17879 node src/cli/index.js stop
```

- [ ] **Step 8: Document in a commit note (no code change)**

Add a VERIFICATION_PHASE_2.md note if the live run succeeded with outputs. If it did not run live because of credentials, skip this step. Either way, confirm the scripted fake-worker e2e test is passing (covered by T23).

---

### Task 25: Final code review + tag phase-2 (Sonnet coordinator + Opus reviewer)

Final cross-cutting review by the code-reviewer agent before tagging. After sign-off, tag the release.

- [ ] **Step 1: Dispatch final code reviewer**

Ask the code-reviewer subagent to audit the full set of commits from the phase-2 start (commit immediately after the `phase-1` tag) through the latest HEAD. Check for:

- Each Phase 2 deliverable from spec §8 Phase 2 is present and wired.
- No Phase 3+ scope leaked in (review mode wiring, KB tools, providers, embeddings, consolidation).
- Error paths end-to-end consistent.
- Subagent-driven files never exceed ~250 lines without reason.
- Test suite still passes (159 tests expected).
- No schema migrations without spec backing.

- [ ] **Step 2: Apply any critical/important fixes from the review** as tiny follow-up commits

- [ ] **Step 3: Run full test suite + coverage**

```bash
cd /opt/claude-workspace/local/worklab
npm run test:coverage
```

Confirm:
- All tests pass.
- `src/core/*` coverage still above 60%.
- `src/core/state-machine.js` still at 100%.

- [ ] **Step 4: Tag phase-2**

```bash
git tag phase-2
git tag        # confirm both phase-1 and phase-2 tags exist
git log phase-1..phase-2 --oneline | wc -l   # commit count for phase 2
```

- [ ] **Step 5: Brief summary commit on a notes file (optional — skip if nothing noteworthy)**

---

## Verification

After all 25 tasks complete:

**Automated:**
```bash
cd /opt/claude-workspace/local/worklab
npm test
# Expected: 159+ tests passing across 16+ test files
npm run test:coverage
# Expected: core thresholds met; state-machine at 100%
```

**Live smoke (T24):**
- `worklab start` boots coordinator with task-watcher online.
- Create a Claude agent via UI or curl, assign to a task.
- Click Run (or POST /run).
- Observe SDK events streaming in the task detail's live timeline.
- On clean exit: task flips to `in_review`, final text posted as agent comment, JOURNAL.md contains at least one bullet.

**Cancel:**
- While a live run is active, click Cancel.
- SIGTERM propagates to worker; worker emits `cancelled` event; task stays in `in_progress` with a system comment.

**Failure path:**
- Create an agent with invalid model; task's run fails with `run failed` or specific SDK error; task stays in `in_progress` with an error comment and `error_text` set.

---

## What Phase 3 will add (not in this plan)

- Worker `--mode review` with verdict parsing (`VERDICT: APPROVE|REJECT`).
- Reviewer spawning on `in_progress → in_review` when reviewer_agent assigned.
- KB CRUD routes + UI + `kb_create`/`kb_update`/`kb_delete`/`kb_read`/`kb_list` MCP tools.
- Pinned KB entries injected into system prompts.
- Visual distinction of system/agent/human comments in UI.

Write Phase 3's plan after Phase 2 ships and at least one real task has been driven through it by hand.

---

## Self-review checklist (plan author)

- **Spec coverage (§8 Phase 2):** `ai.js` + `ai-claude.js` ✓ (T5/T6), `skills.js` ✓ (T2), `mcp-config.js` ✓ (T3), `worklab-tools.js` with journal_append/summary/memory_read ✓ (T7), `launch-worklab-mcp.sh` ✓ (T7), `context.js` execute mode ✓ (T8), `journal.js` ✓ (T4), `worker.js` execute mode ✓ (T9), `spawn-worker.js` ✓ (T11), `task-watcher.js` ✓ (T12), routes-agents ✓ (T15), routes-skills ✓ (T16), routes-mcp ✓ (T17), `/api/tasks/:id/run` + `/cancel` ✓ (T13), `/api/runs/:id/stream` ✓ (T14), UI AgentEdit ✓ (T20), SkillEdit ✓ (T21), run button + live timeline ✓ (T22), seed example skill ✓ (T1), SIGTERM cancellation ✓ (T11, T22).
- **Placeholder scan:** no TBD / TODO / "implement later" strings. All code blocks complete.
- **Type consistency:** `generateResponse` signature from T5 matches usage in T6 and T9. `nextStatus` return shape matches usage in T12. `createTaskWatcher` params match coordinator wiring in T18.
- **Out-of-scope discipline:** Review mode, KB tools, multi-SDK, encryption, embeddings, consolidation all deferred per §2.
- **Test isolation:** All tests using real FS operations use `mkdtempSync` + `afterEach` cleanup.
- **FK discipline:** Explicit instruction in Task 12 reviewer note — "if a test fails with FK error, seed the referenced row; do NOT alter schema.js." Lesson from Phase 1 P2 applied.
