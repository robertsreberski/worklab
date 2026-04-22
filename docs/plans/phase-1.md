> Phase 1 implementation plan. Copied 2026-04-22 from the workspace plan at `/opt/claude-workspace/docs/superpowers/plans/2026-04-21-worklab-phase-1.md`.

# Worklab — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `/opt/claude-workspace/docs/superpowers/specs/2026-04-21-worklab-design.md` (authoritative — read §3–§6 and §8 before starting).

**Repo root:** `/opt/claude-workspace/local/worklab` (this is a fresh greenfield directory, a separate git repo from `/opt/claude-workspace/`). Create the directory, `git init` inside it, and treat it as an independent repo.

**Goal:** Ship Phase 1 of Worklab — a local-only task board with full CRUD, kanban drag-and-drop, comments, settings, and CLI (`start`/`stop`/`status`/`doctor`). **No agent runtime yet.** You can create tasks, drag them between the four columns, comment on them, delete them. A pure-function state machine backs all status transitions.

**Architecture:** Single Node coordinator (`src/coordinator.js`) serves Express + SSE + static UI. SQLite (WAL mode) via better-sqlite3. State machine is a pure reducer (`src/core/state-machine.js`) consumed by API routes. Preact + Vite UI with hash routing served from `src/ui/dist/`. Tests via Vitest.

**Tech Stack:** Node 20+, ESM, better-sqlite3, express, pino, nanoid, preact, vite, @preact/preset-vite, vitest, @vitest/coverage-v8.

**Out of scope for Phase 1** (lands in later phase plans): agents, workers, running tasks, skills, KB, providers, MCP, embeddings, consolidation, service install, backup, markdown editor with preview.

---

## Context

Worklab is a personal, local-only AI agent orchestration tool inspired by Assistant AI but stripped of WhatsApp/personality/evolution. Phase 1 intentionally defers all agent runtime to prove the skeleton end-to-end: DB + API + state machine + UI + CLI. This minimizes risk — if the kanban flow or DB migrations are wrong, we find out before writing any worker or SDK code. Phase 2 layers Claude agent execution on top of the finished skeleton.

Every design decision (schema, state transitions, endpoint shapes, file paths, framework choices) is already pinned in the spec. This plan translates those decisions into TDD-sized tasks.

---

## File structure to be created

```
worklab/
├── .gitignore
├── .nvmrc                       (node 20)
├── README.md                    (short — link to spec)
├── package.json
├── package-lock.json
├── vitest.config.js
├── data-template/
│   ├── config/
│   │   └── mcp.json             ({"mcpServers": {}})
│   ├── knowledge/
│   │   └── welcome.md
│   └── skills/.gitkeep
├── src/
│   ├── coordinator.js           (entry point; wires everything)
│   ├── cli/
│   │   ├── index.js             (bin dispatch)
│   │   ├── start.js
│   │   ├── stop.js
│   │   ├── status.js
│   │   └── doctor.js
│   ├── core/
│   │   ├── db.js                (singleton + migrations)
│   │   ├── schema.js            (DDL strings)
│   │   ├── config.js            (env + defaults)
│   │   ├── logger.js            (pino)
│   │   ├── state-machine.js     (pure reducer)
│   │   ├── first-boot.js        (seed data-template → data)
│   │   └── ids.js               (nanoid helpers)
│   ├── api/
│   │   ├── server.js            (express factory)
│   │   ├── sse.js               (broker)
│   │   ├── routes-tasks.js
│   │   ├── routes-settings.js
│   │   └── routes-activity.js
│   ├── ui/
│   │   ├── index.html
│   │   ├── vite.config.js
│   │   └── src/
│   │       ├── main.jsx
│   │       ├── App.jsx
│   │       ├── routes/
│   │       │   ├── Kanban.jsx
│   │       │   ├── TaskDetail.jsx
│   │       │   └── Settings.jsx
│   │       ├── lib/
│   │       │   ├── api.js
│   │       │   └── useSSE.js
│   │       ├── components/
│   │       │   ├── TaskCard.jsx
│   │       │   ├── NewTaskModal.jsx
│   │       │   └── CommentList.jsx
│   │       └── styles.css
│   └── __tests__/
│       ├── helpers/
│       │   ├── test-db.js        (in-memory DB factory)
│       │   └── test-server.js    (supertest wrapper)
│       ├── core/
│       │   ├── config.test.js
│       │   ├── db.test.js
│       │   ├── state-machine.test.js
│       │   ├── first-boot.test.js
│       │   └── ids.test.js
│       ├── api/
│       │   ├── routes-tasks.test.js
│       │   ├── routes-settings.test.js
│       │   ├── routes-activity.test.js
│       │   └── sse.test.js
│       └── e2e/
│           └── smoke.test.js
└── data/                         (gitignored, seeded from data-template on first boot)
```

---

## Tasks

### Task 1: Repo init + package.json + .gitignore

**Files:**
- Create: `/opt/claude-workspace/local/worklab/.gitignore`
- Create: `/opt/claude-workspace/local/worklab/.nvmrc`
- Create: `/opt/claude-workspace/local/worklab/README.md`
- Create: `/opt/claude-workspace/local/worklab/package.json`

- [ ] **Step 1: Create the repo directory and init git**

```bash
mkdir -p /opt/claude-workspace/local/worklab
cd /opt/claude-workspace/local/worklab
git init -b main
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
data/
src/ui/dist/
*.log
.DS_Store
.env
.env.local
coverage/
```

- [ ] **Step 3: Write `.nvmrc`**

```
20
```

- [ ] **Step 4: Write `README.md`**

```markdown
# Worklab

Local, single-user AI agent orchestration tool for work tasks.

Design spec: `/opt/claude-workspace/docs/superpowers/specs/2026-04-21-worklab-design.md`

## Quick start

\`\`\`bash
npm install
npm run build:ui
npm start
\`\`\`

Open http://localhost:7878.
```

- [ ] **Step 5: Write `package.json`**

```json
{
  "name": "worklab",
  "version": "0.1.0",
  "description": "Local AI agent orchestration tool",
  "type": "module",
  "private": true,
  "bin": { "worklab": "./src/cli/index.js" },
  "scripts": {
    "start": "node src/cli/index.js start",
    "dev": "node src/cli/index.js start",
    "build:ui": "vite build --config src/ui/vite.config.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "better-sqlite3": "^11.7.0",
    "cors": "^2.8.5",
    "express": "^4.21.0",
    "nanoid": "^5.0.9",
    "pino": "^9.5.0",
    "preact": "^10.25.0"
  },
  "devDependencies": {
    "@preact/preset-vite": "^2.9.1",
    "@vitest/coverage-v8": "^2.1.0",
    "supertest": "^7.0.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 6: Install and commit**

```bash
npm install
git add .gitignore .nvmrc README.md package.json package-lock.json
git commit -m "chore: repo init"
```

Expected: `node_modules/` present, `package-lock.json` created.

---

### Task 2: Vitest config + smoke test

**Files:**
- Create: `vitest.config.js`
- Create: `src/__tests__/smoke.test.js`

- [ ] **Step 1: Write `vitest.config.js`**

```javascript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.js"],
    coverage: {
      include: ["src/**/*.js"],
      exclude: ["src/__tests__/**", "src/ui/**"],
      thresholds: { lines: 60, functions: 60, branches: 60, statements: 60 },
    },
  },
});
```

- [ ] **Step 2: Write smoke test**

```javascript
// src/__tests__/smoke.test.js
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("passes", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: Run the test**

```bash
npm test
```

Expected: 1 test file, 1 test, passing.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.js src/__tests__/smoke.test.js
git commit -m "chore: vitest config + smoke test"
```

---

### Task 3: Logger (pino)

**Files:**
- Create: `src/core/logger.js`

- [ ] **Step 1: Write logger module**

```javascript
// src/core/logger.js
import pino from "pino";

export function createLogger(options = {}) {
  return pino({
    level: process.env.WORKLAB_LOG_LEVEL || "info",
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options,
  });
}

export const logger = createLogger();
```

- [ ] **Step 2: Commit** (no test — thin wrapper around pino, covered by usage in later tasks)

```bash
git add src/core/logger.js
git commit -m "feat(core): pino logger wrapper"
```

---

### Task 4: Config loader

**Files:**
- Create: `src/core/config.js`
- Create: `src/__tests__/core/config.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// src/__tests__/core/config.test.js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../core/config.js";

describe("loadConfig", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("WORKLAB_")) delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns defaults when no env set", () => {
    const c = loadConfig();
    expect(c.port).toBe(7878);
    expect(c.dataDir).toMatch(/\/data$/);
    expect(c.logLevel).toBe("info");
  });

  it("honors WORKLAB_PORT", () => {
    process.env.WORKLAB_PORT = "9000";
    expect(loadConfig().port).toBe(9000);
  });

  it("honors WORKLAB_DATA_DIR", () => {
    process.env.WORKLAB_DATA_DIR = "/tmp/custom";
    expect(loadConfig().dataDir).toBe("/tmp/custom");
  });

  it("resolves workspace default to ~/worklab-workspace", () => {
    const c = loadConfig();
    expect(c.workspace).toMatch(/worklab-workspace$/);
  });
});
```

- [ ] **Step 2: Run, verify they fail** — `npm test src/__tests__/core/config.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement**

```javascript
// src/core/config.js
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

export function loadConfig(env = process.env) {
  return {
    port: parseInt(env.WORKLAB_PORT || "7878", 10),
    dataDir: env.WORKLAB_DATA_DIR || resolve(repoRoot, "data"),
    workspace: env.WORKLAB_WORKSPACE || resolve(homedir(), "worklab-workspace"),
    logLevel: env.WORKLAB_LOG_LEVEL || "info",
    timezone: env.WORKLAB_TIMEZONE,
    repoRoot,
  };
}

export const config = loadConfig();
```

- [ ] **Step 4: Run tests, verify pass** — `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.js src/__tests__/core/config.test.js
git commit -m "feat(core): config loader with env overrides"
```

---

### Task 5: ID helpers (nanoid wrappers)

**Files:**
- Create: `src/core/ids.js`
- Create: `src/__tests__/core/ids.test.js`

- [ ] **Step 1: Test**

```javascript
// src/__tests__/core/ids.test.js
import { describe, it, expect } from "vitest";
import { newTaskId, newCommentId, newRunId, newProviderId } from "../../core/ids.js";

describe("ids", () => {
  it("newTaskId is 21 chars", () => expect(newTaskId()).toHaveLength(21));
  it("newCommentId is 21 chars", () => expect(newCommentId()).toHaveLength(21));
  it("newRunId is 21 chars", () => expect(newRunId()).toHaveLength(21));
  it("newProviderId is 12 chars", () => expect(newProviderId()).toHaveLength(12));
  it("ids are unique", () => {
    const s = new Set();
    for (let i = 0; i < 1000; i++) s.add(newTaskId());
    expect(s.size).toBe(1000);
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

```javascript
// src/core/ids.js
import { customAlphabet } from "nanoid";

const alpha = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const nid21 = customAlphabet(alpha, 21);
const nid12 = customAlphabet(alpha, 12);

export const newTaskId = () => nid21();
export const newCommentId = () => nid21();
export const newRunId = () => nid21();
export const newAgentLogId = () => nid21();
export const newEmbeddingId = () => nid21();
export const newProviderId = () => nid12();
export const newModelId = () => nid21();
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/core/ids.js src/__tests__/core/ids.test.js
git commit -m "feat(core): id helpers"
```

---

### Task 6: DB schema DDL module

**Files:**
- Create: `src/core/schema.js`

- [ ] **Step 1: Write schema DDL**

Copy the full schema from spec §4.1 into a single exported constant. One `CREATE TABLE` per table. One `CREATE INDEX` per index. Order matters only for foreign keys (agents before tasks, tasks before runs/comments, runs before logs, providers before models).

```javascript
// src/core/schema.js
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  sdk TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL DEFAULT 'medium',
  instructions TEXT NOT NULL DEFAULT '',
  skills_allowlist TEXT NOT NULL DEFAULT '[]',
  mcp_allowlist TEXT NOT NULL DEFAULT '[]',
  builtin_allowlist TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  executor_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
  reviewer_agent TEXT REFERENCES agents(name) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  error_text TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  worker_pid INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER,
  error_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_logs (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  events TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  num_turns INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_run ON agent_logs(task_run_id);

CREATE TABLE IF NOT EXISTS custom_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider_type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_encrypted TEXT,
  trust_public_url INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES custom_providers(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  alias TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(provider_id, model_name)
);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  vector BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
```

- [ ] **Step 2: Commit** (no test yet — exercised by `db.js` tests in Task 7)

```bash
git add src/core/schema.js
git commit -m "feat(core): full db schema DDL"
```

---

### Task 7: DB singleton + migration runner

**Files:**
- Create: `src/core/db.js`
- Create: `src/__tests__/helpers/test-db.js`
- Create: `src/__tests__/core/db.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// src/__tests__/core/db.test.js
import { describe, it, expect } from "vitest";
import { openDb, runMigrations } from "../../core/db.js";
import { newTaskId } from "../../core/ids.js";

describe("openDb + runMigrations", () => {
  it("creates all tables on first call", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(r => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "agents", "tasks", "task_comments", "task_runs", "agent_logs",
        "custom_providers", "custom_models", "embeddings", "settings",
      ]),
    );
  });

  it("idempotent: safe to run twice", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      "INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(newTaskId(), "ok", now, now);
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks").get().c).toBe(1);
  });

  it("enforces foreign keys", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(() =>
      db
        .prepare("INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("c1", "does-not-exist", "human", "hi", Date.now()),
    ).toThrow();
  });

  it("records schema version", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const row = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get();
    expect(row.value).toBe("1");
  });
});
```

- [ ] **Step 2: Write test helper** (for use in later tests)

```javascript
// src/__tests__/helpers/test-db.js
import { openDb, runMigrations } from "../../core/db.js";

export function makeTestDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}
```

- [ ] **Step 3: Run tests, verify fail** — module not found.

- [ ] **Step 4: Implement `db.js`**

```javascript
// src/core/db.js
import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

let singleton = null;

export function openDb(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function runMigrations(db) {
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(SCHEMA_VERSION));
}

export function getDb(path) {
  if (singleton) return singleton;
  singleton = openDb(path);
  runMigrations(singleton);
  return singleton;
}

export function closeDb() {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

- [ ] **Step 6: Commit**

```bash
git add src/core/db.js src/__tests__/helpers/test-db.js src/__tests__/core/db.test.js
git commit -m "feat(core): db singleton + idempotent migrations"
```

---

### Task 8: First-boot seeding (data-template → data)

**Files:**
- Create: `data-template/config/mcp.json`
- Create: `data-template/knowledge/welcome.md`
- Create: `data-template/skills/.gitkeep`
- Create: `src/core/first-boot.js`
- Create: `src/__tests__/core/first-boot.test.js`

- [ ] **Step 1: Create template files**

```bash
mkdir -p data-template/config data-template/knowledge data-template/skills
```

`data-template/config/mcp.json`:
```json
{ "mcpServers": {} }
```

`data-template/knowledge/welcome.md`:
```markdown
---
title: Welcome to Worklab
slug: welcome
tags: [meta]
category: meta
pinned: true
author: human
created_at: 2026-04-21T00:00:00Z
updated_at: 2026-04-21T00:00:00Z
---

This is the shared knowledge base. Agents read and write here. Pinned entries are included in every agent's system prompt.
```

`data-template/skills/.gitkeep`: (empty file)

- [ ] **Step 2: Write failing tests**

```javascript
// src/__tests__/core/first-boot.test.js
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDataFromTemplate } from "../../core/first-boot.js";

describe("seedDataFromTemplate", () => {
  const created = [];
  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  function mkDir(name) {
    const p = mkdtempSync(join(tmpdir(), `worklab-fb-${name}-`));
    created.push(p);
    return p;
  }

  it("copies template files when data dir is missing", () => {
    const template = mkDir("tpl");
    const data = join(mkDir("parent"), "data");
    mkdirSync(join(template, "knowledge"), { recursive: true });
    writeFileSync(join(template, "knowledge", "welcome.md"), "hello");
    seedDataFromTemplate({ templateDir: template, dataDir: data });
    expect(existsSync(join(data, "knowledge", "welcome.md"))).toBe(true);
    expect(readFileSync(join(data, "knowledge", "welcome.md"), "utf8")).toBe("hello");
  });

  it("is a no-op when data dir already exists and is non-empty", () => {
    const template = mkDir("tpl2");
    const data = mkDir("data2");
    mkdirSync(join(template, "knowledge"), { recursive: true });
    writeFileSync(join(template, "knowledge", "welcome.md"), "template");
    writeFileSync(join(data, "existing.txt"), "mine");
    seedDataFromTemplate({ templateDir: template, dataDir: data });
    expect(existsSync(join(data, "knowledge", "welcome.md"))).toBe(false);
    expect(readFileSync(join(data, "existing.txt"), "utf8")).toBe("mine");
  });
});
```

- [ ] **Step 3: Run tests, verify fail**

- [ ] **Step 4: Implement**

```javascript
// src/core/first-boot.js
import { cpSync, existsSync, readdirSync, mkdirSync } from "node:fs";

export function seedDataFromTemplate({ templateDir, dataDir }) {
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) return { seeded: false };
  if (!existsSync(templateDir)) return { seeded: false, reason: "no-template" };
  mkdirSync(dataDir, { recursive: true });
  cpSync(templateDir, dataDir, { recursive: true });
  return { seeded: true };
}
```

- [ ] **Step 5: Run tests, verify pass**

- [ ] **Step 6: Commit**

```bash
git add data-template/ src/core/first-boot.js src/__tests__/core/first-boot.test.js
git commit -m "feat(core): first-boot seeds data/ from data-template/"
```

---

### Task 9: State machine — skeleton + `todo → in_progress`

**Files:**
- Create: `src/core/state-machine.js`
- Create: `src/__tests__/core/state-machine.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// src/__tests__/core/state-machine.test.js
import { describe, it, expect } from "vitest";
import { nextStatus } from "../../core/state-machine.js";

describe("nextStatus", () => {
  it("todo + run_requested → in_progress, spawn_executor", () => {
    const r = nextStatus("todo", { type: "run_requested", executorAgent: "coder" });
    expect(r.status).toBe("in_progress");
    expect(r.sideEffects).toContainEqual({ type: "spawn_executor", agentName: "coder" });
  });

  it("todo + run_requested without executor → 'error' side effect, status unchanged", () => {
    const r = nextStatus("todo", { type: "run_requested", executorAgent: null });
    expect(r.status).toBe("todo");
    expect(r.sideEffects).toContainEqual({ type: "error", message: expect.stringContaining("no executor") });
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement minimal**

```javascript
// src/core/state-machine.js
export const STATUSES = ["todo", "in_progress", "in_review", "done"];

export function nextStatus(current, event) {
  const unchanged = (sideEffects = []) => ({ status: current, sideEffects });
  const change = (status, sideEffects = []) => ({ status, sideEffects });

  switch (event.type) {
    case "run_requested":
      if (current !== "todo" && current !== "in_progress") {
        return unchanged([{ type: "error", message: `cannot run from ${current}` }]);
      }
      if (!event.executorAgent) {
        return unchanged([{ type: "error", message: "no executor assigned" }]);
      }
      return change("in_progress", [{ type: "spawn_executor", agentName: event.executorAgent }]);
    default:
      return unchanged([{ type: "error", message: `unknown event ${event.type}` }]);
  }
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/core/state-machine.js src/__tests__/core/state-machine.test.js
git commit -m "feat(core): state-machine skeleton + run_requested"
```

---

### Task 10: State machine — `in_progress` transitions

- [ ] **Step 1: Extend tests**

Append to `state-machine.test.js`:

```javascript
describe("in_progress transitions", () => {
  it("run_completed with reviewer → in_review, spawn_reviewer", () => {
    const r = nextStatus("in_progress", { type: "run_completed", reviewerAgent: "checker" });
    expect(r.status).toBe("in_review");
    expect(r.sideEffects).toContainEqual({ type: "spawn_reviewer", agentName: "checker" });
  });

  it("run_completed without reviewer → in_review, no spawn", () => {
    const r = nextStatus("in_progress", { type: "run_completed", reviewerAgent: null });
    expect(r.status).toBe("in_review");
    expect(r.sideEffects.some(s => s.type === "spawn_reviewer")).toBe(false);
  });

  it("run_failed → stays in_progress, posts error comment, red badge", () => {
    const r = nextStatus("in_progress", { type: "run_failed", message: "timeout" });
    expect(r.status).toBe("in_progress");
    expect(r.sideEffects).toContainEqual({ type: "post_error_comment", message: "timeout" });
    expect(r.sideEffects).toContainEqual({ type: "mark_badge_red" });
  });
});
```

- [ ] **Step 2: Run, verify fail for the 3 new cases**

- [ ] **Step 3: Extend implementation**

Add cases to the switch in `state-machine.js`:

```javascript
    case "run_completed":
      if (current !== "in_progress") {
        return unchanged([{ type: "error", message: `cannot complete from ${current}` }]);
      }
      return change(
        "in_review",
        event.reviewerAgent
          ? [{ type: "spawn_reviewer", agentName: event.reviewerAgent }]
          : [],
      );
    case "run_failed":
      if (current !== "in_progress") {
        return unchanged([{ type: "error", message: `cannot fail from ${current}` }]);
      }
      return unchanged([
        { type: "post_error_comment", message: event.message || "run failed" },
        { type: "mark_badge_red" },
      ]);
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/core/state-machine.js src/__tests__/core/state-machine.test.js
git commit -m "feat(core): state-machine in_progress transitions"
```

---

### Task 11: State machine — `in_review` transitions

- [ ] **Step 1: Extend tests**

```javascript
describe("in_review transitions", () => {
  it("review_approved → done, set_completed_at", () => {
    const r = nextStatus("in_review", { type: "review_approved" });
    expect(r.status).toBe("done");
    expect(r.sideEffects).toContainEqual({ type: "set_completed_at" });
  });

  it("review_rejected → in_progress, post comment, clear error", () => {
    const r = nextStatus("in_review", { type: "review_rejected", notes: "not ok" });
    expect(r.status).toBe("in_progress");
    expect(r.sideEffects).toContainEqual({ type: "post_review_comment", notes: "not ok" });
    expect(r.sideEffects).toContainEqual({ type: "clear_error_text" });
  });
});
```

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement**

```javascript
    case "review_approved":
      if (current !== "in_review") {
        return unchanged([{ type: "error", message: `cannot approve from ${current}` }]);
      }
      return change("done", [{ type: "set_completed_at" }]);
    case "review_rejected":
      if (current !== "in_review") {
        return unchanged([{ type: "error", message: `cannot reject from ${current}` }]);
      }
      return change("in_progress", [
        { type: "post_review_comment", notes: event.notes || "" },
        { type: "clear_error_text" },
      ]);
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(core): state-machine review transitions"
```

---

### Task 12: State machine — human_move (manual drag) transitions

- [ ] **Step 1: Tests**

```javascript
describe("human_move transitions", () => {
  it.each([
    ["todo", "in_progress"],
    ["in_progress", "todo"],
    ["in_progress", "in_review"],
    ["in_review", "done"],
    ["in_review", "in_progress"],
    ["done", "todo"],
    ["done", "in_progress"],
    ["done", "in_review"],
  ])("%s → %s via human_move is allowed", (from, to) => {
    const r = nextStatus(from, { type: "human_move", target: to });
    expect(r.status).toBe(to);
  });

  it("rejects invalid target", () => {
    const r = nextStatus("todo", { type: "human_move", target: "mystery" });
    expect(r.status).toBe("todo");
    expect(r.sideEffects.some(s => s.type === "error")).toBe(true);
  });

  it("sets completed_at on human_move → done", () => {
    const r = nextStatus("in_review", { type: "human_move", target: "done" });
    expect(r.sideEffects).toContainEqual({ type: "set_completed_at" });
  });

  it("clears completed_at on human_move from done → anywhere else", () => {
    const r = nextStatus("done", { type: "human_move", target: "todo" });
    expect(r.sideEffects).toContainEqual({ type: "clear_completed_at" });
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
    case "human_move": {
      if (!STATUSES.includes(event.target)) {
        return unchanged([{ type: "error", message: `invalid target ${event.target}` }]);
      }
      const sideEffects = [];
      if (event.target === "done") sideEffects.push({ type: "set_completed_at" });
      if (current === "done" && event.target !== "done") sideEffects.push({ type: "clear_completed_at" });
      return change(event.target, sideEffects);
    }
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(core): state-machine human_move transitions"
```

---

### Task 13: State machine — exhaustive transition matrix test

- [ ] **Step 1: Add coverage test**

Append to `state-machine.test.js`:

```javascript
describe("transition coverage", () => {
  it("rejects run_requested from invalid states with error", () => {
    for (const s of ["in_review", "done"]) {
      const r = nextStatus(s, { type: "run_requested", executorAgent: "x" });
      expect(r.status).toBe(s);
      expect(r.sideEffects.some(se => se.type === "error")).toBe(true);
    }
  });

  it("unknown event type yields error", () => {
    const r = nextStatus("todo", { type: "bogus" });
    expect(r.status).toBe("todo");
    expect(r.sideEffects[0].type).toBe("error");
  });
});
```

- [ ] **Step 2: Run — should pass** (already implemented by earlier tasks).

- [ ] **Step 3: Verify branch coverage**

```bash
npm run test:coverage
```

Confirm `src/core/state-machine.js` shows 100% line + branch coverage. If not, add cases to hit gaps.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "test(core): state-machine full transition coverage"
```

---

### Task 14: SSE broker

**Files:**
- Create: `src/api/sse.js`
- Create: `src/__tests__/api/sse.test.js`

- [ ] **Step 1: Tests**

```javascript
// src/__tests__/api/sse.test.js
import { describe, it, expect, vi } from "vitest";
import { createSseBroker } from "../../api/sse.js";

function fakeRes() {
  const writes = [];
  return {
    writeHead: vi.fn(),
    write: vi.fn(s => writes.push(s)),
    end: vi.fn(),
    on: vi.fn(),
    writes,
  };
}

describe("sse broker", () => {
  it("subscribes a client and broadcasts to it", () => {
    const broker = createSseBroker();
    const res = fakeRes();
    broker.subscribe("channel-1", res);
    broker.broadcast("channel-1", { type: "hello" });
    expect(res.write).toHaveBeenCalled();
    expect(res.writes.join("")).toMatch(/"type":"hello"/);
  });

  it("broadcast to unknown channel is a no-op", () => {
    const broker = createSseBroker();
    expect(() => broker.broadcast("missing", { x: 1 })).not.toThrow();
  });

  it("unsubscribe removes a client so it stops receiving", () => {
    const broker = createSseBroker();
    const res = fakeRes();
    broker.subscribe("c", res);
    broker.unsubscribe("c", res);
    broker.broadcast("c", { x: 1 });
    expect(res.write).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/api/sse.js
export function createSseBroker() {
  const channels = new Map(); // name → Set<res>

  function subscribe(name, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(": connected\n\n");
    let set = channels.get(name);
    if (!set) channels.set(name, (set = new Set()));
    set.add(res);
    res.on("close", () => unsubscribe(name, res));
  }

  function unsubscribe(name, res) {
    const set = channels.get(name);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) channels.delete(name);
  }

  function broadcast(name, payload) {
    const set = channels.get(name);
    if (!set) return;
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      try { res.write(line); } catch { /* client went away */ }
    }
  }

  function size(name) {
    return channels.get(name)?.size ?? 0;
  }

  return { subscribe, unsubscribe, broadcast, size };
}
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git add src/api/sse.js src/__tests__/api/sse.test.js
git commit -m "feat(api): sse broker"
```

---

### Task 15: Express server factory

**Files:**
- Create: `src/api/server.js`
- Create: `src/__tests__/helpers/test-server.js`

- [ ] **Step 1: Write factory**

```javascript
// src/api/server.js
import express from "express";
import cors from "cors";
import { createSseBroker } from "./sse.js";
import { registerTaskRoutes } from "./routes-tasks.js";
import { registerSettingsRoutes } from "./routes-settings.js";
import { registerActivityRoutes } from "./routes-activity.js";

export function createServer({ db, logger }) {
  const app = express();
  const broker = createSseBroker();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/events/stream", (req, res) => broker.subscribe("global", res));

  registerTaskRoutes(app, { db, broker, logger });
  registerSettingsRoutes(app, { db, broker, logger });
  registerActivityRoutes(app, { db, logger });

  app.use((err, _req, res, _next) => {
    logger?.error?.({ err }, "unhandled error");
    res.status(500).json({ error: { code: "internal", message: err.message } });
  });

  return { app, broker };
}
```

- [ ] **Step 2: Write test helper**

```javascript
// src/__tests__/helpers/test-server.js
import supertest from "supertest";
import { makeTestDb } from "./test-db.js";
import { createServer } from "../../api/server.js";

export function makeTestServer() {
  const db = makeTestDb();
  const { app, broker } = createServer({ db, logger: undefined });
  return { app, broker, db, agent: supertest(app) };
}
```

- [ ] **Step 3: Commit** (routes modules will be added next — this task leaves server.js with broken imports, which is fine because we do not run it yet)

```bash
git add src/api/server.js src/__tests__/helpers/test-server.js
git commit -m "feat(api): express server factory (route modules next)"
```

---

### Task 16: `routes-tasks.js` — GET list + POST create

**Files:**
- Create: `src/api/routes-tasks.js`
- Create: `src/__tests__/api/routes-tasks.test.js`

- [ ] **Step 1: Tests**

```javascript
// src/__tests__/api/routes-tasks.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("GET /api/tasks", () => {
  it("returns empty list initially", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/tasks").expect(200);
    expect(res.body).toEqual({ tasks: [] });
  });
});

describe("POST /api/tasks", () => {
  it("creates a task with required fields", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/tasks").send({ title: "do thing" }).expect(201);
    expect(res.body.task.id).toMatch(/^[a-zA-Z0-9]{21}$/);
    expect(res.body.task.title).toBe("do thing");
    expect(res.body.task.status).toBe("todo");
    expect(res.body.task.priority).toBe(0);
  });

  it("rejects missing title", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/tasks").send({}).expect(400);
  });

  it("returns new task in GET list", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/tasks").send({ title: "a" });
    await agent.post("/api/tasks").send({ title: "b" });
    const res = await agent.get("/api/tasks").expect(200);
    expect(res.body.tasks.map(t => t.title).sort()).toEqual(["a", "b"]);
  });

  it("broadcasts task_created", async () => {
    const { agent, broker } = makeTestServer();
    let captured = null;
    broker.broadcast = (ch, p) => { if (ch === "global") captured = p; };
    await agent.post("/api/tasks").send({ title: "watch me" });
    expect(captured).toMatchObject({ type: "task_created" });
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement routes-tasks.js**

```javascript
// src/api/routes-tasks.js
import { newTaskId, newCommentId } from "../core/ids.js";

function rowToTask(row) {
  if (!row) return null;
  return {
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    priority: row.priority ?? 0,
    retry_count: row.retry_count ?? 0,
  };
}

export function registerTaskRoutes(app, { db, broker }) {
  app.get("/api/tasks", (req, res) => {
    const rows = db
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC")
      .all();
    res.json({ tasks: rows.map(rowToTask) });
  });

  app.post("/api/tasks", (req, res) => {
    const { title, description = "", instructions = "", executor_agent = null, reviewer_agent = null, priority = 0, tags = [] } = req.body || {};
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "title is required" } });
    }
    const id = newTaskId();
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, title, description, instructions, executor_agent, reviewer_agent, priority, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, description, instructions, executor_agent, reviewer_agent, priority, JSON.stringify(tags), now, now);
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    const task = rowToTask(row);
    broker.broadcast("global", { type: "task_created", id });
    res.status(201).json({ task });
  });
}
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git add src/api/routes-tasks.js src/__tests__/api/routes-tasks.test.js
git commit -m "feat(api): tasks list + create"
```

---

### Task 17: `routes-tasks.js` — GET single + PATCH (non-status)

- [ ] **Step 1: Extend tests**

```javascript
describe("GET /api/tasks/:id", () => {
  it("returns 404 for missing task", async () => {
    const { agent } = makeTestServer();
    await agent.get("/api/tasks/nope").expect(404);
  });

  it("returns task with comments and runs arrays", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.get(`/api/tasks/${task.id}`).expect(200);
    expect(res.body.task.id).toBe(task.id);
    expect(res.body.comments).toEqual([]);
    expect(res.body.runs).toEqual([]);
  });
});

describe("PATCH /api/tasks/:id", () => {
  it("updates title, description, instructions", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "orig" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ title: "new", description: "desc" });
    expect(res.body.task.title).toBe("new");
    expect(res.body.task.description).toBe("desc");
  });

  it("PATCH broadcasts task_updated", async () => {
    const { agent, broker } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "a" });
    let got = null;
    broker.broadcast = (ch, p) => { if (ch === "global" && p.type === "task_updated") got = p; };
    await agent.patch(`/api/tasks/${task.id}`).send({ title: "b" });
    expect(got).toEqual({ type: "task_updated", id: task.id });
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Extend routes-tasks.js**

```javascript
  app.get("/api/tasks/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(req.params.id);
    const runs = db
      .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC")
      .all(req.params.id);
    res.json({ task: rowToTask(row), comments, runs });
  });

  const PATCHABLE = ["title", "description", "instructions", "executor_agent", "reviewer_agent", "priority", "tags"];

  app.patch("/api/tasks/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });

    const fields = [];
    const values = [];
    for (const k of PATCHABLE) {
      if (k in req.body) {
        fields.push(`${k} = ?`);
        values.push(k === "tags" ? JSON.stringify(req.body[k] ?? []) : req.body[k]);
      }
    }

    // Status handled in a later task (via state machine)
    if (fields.length === 0 && !("status" in req.body)) {
      return res.json({ task: rowToTask(existing) });
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(Date.now());
      values.push(req.params.id);
      db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }

    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    broker.broadcast("global", { type: "task_updated", id: req.params.id });
    res.json({ task: rowToTask(row) });
  });
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(api): tasks get + patch (non-status fields)"
```

---

### Task 18: `routes-tasks.js` — PATCH status (via state machine)

- [ ] **Step 1: Tests**

```javascript
describe("PATCH /api/tasks/:id status", () => {
  it("human_move todo → in_progress when allowed", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ status: "in_progress" });
    expect(res.body.task.status).toBe("in_progress");
  });

  it("invalid status value returns 400", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ status: "bogus" }).expect(400);
  });

  it("setting status=done sets completed_at", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ status: "in_review" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ status: "done" });
    expect(res.body.task.completed_at).toBeTruthy();
  });

  it("moving done → todo clears completed_at", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ status: "done" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ status: "todo" });
    expect(res.body.task.completed_at).toBeNull();
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Extend PATCH handler**

In `routes-tasks.js`, import the state machine and handle status changes:

```javascript
// at top
import { nextStatus, STATUSES } from "../core/state-machine.js";

// inside app.patch handler, BEFORE the existing field-update block:
if ("status" in req.body) {
  if (!STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: { code: "validation", message: "invalid status" } });
  }
  const result = nextStatus(existing.status, { type: "human_move", target: req.body.status });
  if (result.sideEffects.some(se => se.type === "error")) {
    return res.status(400).json({
      error: { code: "invalid_transition", message: result.sideEffects.find(se => se.type === "error").message },
    });
  }
  let set_completed = null;
  let clear_completed = false;
  for (const se of result.sideEffects) {
    if (se.type === "set_completed_at") set_completed = Date.now();
    if (se.type === "clear_completed_at") clear_completed = true;
  }
  fields.push("status = ?"); values.push(result.status);
  if (set_completed != null) { fields.push("completed_at = ?"); values.push(set_completed); }
  if (clear_completed) { fields.push("completed_at = ?"); values.push(null); }
}
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(api): PATCH status routed through state-machine"
```

---

### Task 19: `routes-tasks.js` — DELETE + comments POST + runs GET

- [ ] **Step 1: Tests**

```javascript
describe("DELETE /api/tasks/:id", () => {
  it("removes task and cascades comments", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "hi" }).expect(201);
    await agent.delete(`/api/tasks/${task.id}`).expect(204);
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks").get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM task_comments").get().c).toBe(0);
  });

  it("returns 404 for missing", async () => {
    const { agent } = makeTestServer();
    await agent.delete("/api/tasks/missing").expect(404);
  });
});

describe("POST /api/tasks/:id/comments", () => {
  it("creates a human comment", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "a note" }).expect(201);
    expect(res.body.comment.body).toBe("a note");
    expect(res.body.comment.author_type).toBe("human");
  });

  it("rejects empty body", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.post(`/api/tasks/${task.id}/comments`).send({}).expect(400);
  });

  it("broadcasts task_updated", async () => {
    const { agent, broker } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const events = [];
    broker.broadcast = (ch, p) => { if (ch === "global") events.push(p); };
    await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "x" });
    expect(events.some(e => e.type === "task_updated")).toBe(true);
  });
});

describe("GET /api/tasks/:id/runs", () => {
  it("returns empty list for new task", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.get(`/api/tasks/${task.id}/runs`).expect(200);
    expect(res.body).toEqual({ runs: [] });
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Extend handler**

```javascript
  app.delete("/api/tasks/:id", (req, res) => {
    const r = db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    broker.broadcast("global", { type: "task_deleted", id: req.params.id });
    res.status(204).end();
  });

  app.post("/api/tasks/:id/comments", (req, res) => {
    const existing = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const { body } = req.body || {};
    if (!body || typeof body !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "body is required" } });
    }
    const id = newCommentId();
    const now = Date.now();
    db.prepare(`
      INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at)
      VALUES (?, ?, 'human', NULL, ?, ?)
    `).run(id, req.params.id, body, now);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, req.params.id);
    broker.broadcast("global", { type: "task_updated", id: req.params.id });
    const row = db.prepare("SELECT * FROM task_comments WHERE id = ?").get(id);
    res.status(201).json({ comment: row });
  });

  app.get("/api/tasks/:id/runs", (req, res) => {
    const existing = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const runs = db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC").all(req.params.id);
    res.json({ runs });
  });
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(api): tasks delete, comments post, runs list"
```

---

### Task 20: `routes-settings.js`

**Files:**
- Create: `src/api/routes-settings.js`
- Create: `src/__tests__/api/routes-settings.test.js`

- [ ] **Step 1: Tests**

```javascript
// src/__tests__/api/routes-settings.test.js
import { describe, it, expect } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("settings", () => {
  it("GET returns defaults when empty", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/settings").expect(200);
    expect(res.body.settings.consolidation_hour).toBe(3);
    expect(res.body.settings.consolidation_enabled).toBe(true);
    expect(res.body.settings.worker_timeout_ms).toBe(1800000);
  });

  it("PATCH writes and GET reads back", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({ consolidation_hour: 5 }).expect(200);
    const res = await agent.get("/api/settings").expect(200);
    expect(res.body.settings.consolidation_hour).toBe(5);
  });

  it("PATCH rejects unknown keys", async () => {
    const { agent } = makeTestServer();
    await agent.patch("/api/settings").send({ bogus: 1 }).expect(400);
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/api/routes-settings.js
const DEFAULTS = {
  consolidation_hour: 3,
  consolidation_enabled: true,
  default_embedding_model: "ollama:nomic-embed-text",
  journal_tail_lines: 80,
  kb_pinned_limit: 10,
  worker_timeout_ms: 1800000,
  cancel_grace_ms: 5000,
};

export function registerSettingsRoutes(app, { db }) {
  function readAll() {
    const rows = db.prepare("SELECT key, value FROM settings").all();
    const out = { ...DEFAULTS };
    for (const row of rows) {
      try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
    }
    return out;
  }

  app.get("/api/settings", (_req, res) => {
    res.json({ settings: readAll() });
  });

  app.patch("/api/settings", (req, res) => {
    const body = req.body || {};
    const unknown = Object.keys(body).filter(k => !(k in DEFAULTS));
    if (unknown.length) {
      return res.status(400).json({ error: { code: "validation", message: `unknown keys: ${unknown.join(",")}` } });
    }
    const stmt = db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const tx = db.transaction((entries) => {
      for (const [k, v] of entries) stmt.run(k, JSON.stringify(v));
    });
    tx(Object.entries(body));
    res.json({ settings: readAll() });
  });
}
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git add src/api/routes-settings.js src/__tests__/api/routes-settings.test.js
git commit -m "feat(api): settings get + patch with defaults"
```

---

### Task 21: `routes-activity.js`

**Files:**
- Create: `src/api/routes-activity.js`
- Create: `src/__tests__/api/routes-activity.test.js`

- [ ] **Step 1: Tests**

```javascript
// src/__tests__/api/routes-activity.test.js
import { describe, it, expect } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("activity", () => {
  it("returns empty when no runs", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/activity").expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it("returns runs with limit + cursor", async () => {
    const { agent, db } = makeTestServer();
    // seed two synthetic runs
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const now = Date.now();
    db.prepare(`INSERT INTO task_runs (id, task_id, mode, agent_name, status, started_at, ended_at)
                VALUES (?, ?, 'execute', 'a', 'complete', ?, ?)`).run("r1", task.id, now - 1000, now);
    db.prepare(`INSERT INTO task_runs (id, task_id, mode, agent_name, status, started_at, ended_at)
                VALUES (?, ?, 'execute', 'a', 'complete', ?, ?)`).run("r2", task.id, now, now + 100);
    const res = await agent.get("/api/activity?limit=1").expect(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].id).toBe("r2");
    expect(res.body.nextCursor).toBeTruthy();
  });
});
```

- [ ] **Step 2: Fail**

- [ ] **Step 3: Implement**

```javascript
// src/api/routes-activity.js
export function registerActivityRoutes(app, { db }) {
  app.get("/api/activity", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;
    const rows = cursor
      ? db.prepare(
          "SELECT r.*, t.title AS task_title FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE r.started_at < ? ORDER BY r.started_at DESC LIMIT ?",
        ).all(cursor, limit + 1)
      : db.prepare(
          "SELECT r.*, t.title AS task_title FROM task_runs r JOIN tasks t ON t.id = r.task_id ORDER BY r.started_at DESC LIMIT ?",
        ).all(limit + 1);
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? items[items.length - 1].started_at : null;
    res.json({ items, nextCursor });
  });
}
```

- [ ] **Step 4: Pass**

- [ ] **Step 5: Commit**

```bash
git add src/api/routes-activity.js src/__tests__/api/routes-activity.test.js
git commit -m "feat(api): activity feed with cursor paging"
```

---

### Task 22: Coordinator entry point

**Files:**
- Create: `src/coordinator.js`

- [ ] **Step 1: Write coordinator**

```javascript
// src/coordinator.js
import { createServer as createHttpServer } from "node:http";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "./api/server.js";
import { getDb } from "./core/db.js";
import { logger } from "./core/logger.js";
import { loadConfig } from "./core/config.js";
import { seedDataFromTemplate } from "./core/first-boot.js";
import express from "express";

export async function startCoordinator({ config = loadConfig() } = {}) {
  const templateDir = join(config.repoRoot, "data-template");
  const seedResult = seedDataFromTemplate({ templateDir, dataDir: config.dataDir });
  if (seedResult.seeded) logger.info("seeded data dir from template");

  const dbPath = join(config.dataDir, "worklab.db");
  const db = getDb(dbPath);

  const { app } = createServer({ db, logger });

  // Serve built UI if present
  const uiDist = join(config.repoRoot, "src/ui/dist");
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get("*", (_req, res) => res.sendFile(join(uiDist, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res.status(503).send("UI not built. Run: npm run build:ui"),
    );
  }

  const http = createHttpServer(app);
  await new Promise((resolve) => http.listen(config.port, resolve));
  logger.info({ port: config.port }, "coordinator listening");

  // Write pid file
  const pidFile = join(config.dataDir, ".coordinator.pid");
  writeFileSync(pidFile, String(process.pid));

  function shutdown() {
    logger.info("shutdown");
    http.close(() => {
      try { unlinkSync(pidFile); } catch {}
      process.exit(0);
    });
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { http, db, config };
}
```

- [ ] **Step 2: Commit** (no unit test — integration tested in Task 30 smoke test)

```bash
git add src/coordinator.js
git commit -m "feat(coordinator): entry point with static UI + pid file"
```

---

### Task 23: CLI dispatcher + `start` command

**Files:**
- Create: `src/cli/index.js`
- Create: `src/cli/start.js`

- [ ] **Step 1: Implement**

```javascript
// src/cli/index.js
#!/usr/bin/env node
import { start } from "./start.js";
import { stop } from "./stop.js";
import { status } from "./status.js";
import { doctor } from "./doctor.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);

const commands = { start, stop, status, doctor };

if (!cmd || !(cmd in commands)) {
  console.error("usage: worklab <start|stop|status|doctor>");
  process.exit(1);
}

commands[cmd](args).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

```javascript
// src/cli/start.js
import { startCoordinator } from "../coordinator.js";

export async function start() {
  await startCoordinator();
  // keep process alive
}
```

- [ ] **Step 2: Make CLI executable**

```bash
chmod +x src/cli/index.js
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/index.js src/cli/start.js
git commit -m "feat(cli): dispatcher + start command"
```

---

### Task 24: CLI `stop`, `status`, `doctor`

**Files:**
- Create: `src/cli/stop.js`
- Create: `src/cli/status.js`
- Create: `src/cli/doctor.js`

- [ ] **Step 1: Implement `stop.js`**

```javascript
// src/cli/stop.js
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";

export async function stop() {
  const config = loadConfig();
  const pidFile = join(config.dataDir, ".coordinator.pid");
  if (!existsSync(pidFile)) {
    console.log("coordinator not running (no pid file)");
    return;
  }
  const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    console.log(`sent SIGTERM to ${pid}`);
  } catch (err) {
    console.log(`process ${pid} not found; cleaning stale pid file`);
    try { unlinkSync(pidFile); } catch {}
  }
}
```

- [ ] **Step 2: Implement `status.js`**

```javascript
// src/cli/status.js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";

export async function status() {
  const config = loadConfig();
  const pidFile = join(config.dataDir, ".coordinator.pid");
  if (!existsSync(pidFile)) {
    console.log("coordinator: not running");
    return;
  }
  const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }

  if (!alive) {
    console.log(`coordinator: stale pid file (pid ${pid} not alive)`);
    return;
  }

  try {
    const res = await fetch(`http://localhost:${config.port}/api/health`);
    const json = await res.json();
    console.log(`coordinator: running pid=${pid} port=${config.port} health=${JSON.stringify(json)}`);
  } catch (err) {
    console.log(`coordinator: pid=${pid} alive but health check failed: ${err.message}`);
  }
}
```

- [ ] **Step 3: Implement `doctor.js`**

```javascript
// src/cli/doctor.js
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { openDb, runMigrations } from "../core/db.js";

export async function doctor() {
  const config = loadConfig();
  const problems = [];

  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) problems.push(`node ${process.versions.node} < 20 required`);

  const dbPath = join(config.dataDir, "worklab.db");
  if (existsSync(dbPath)) {
    const db = openDb(dbPath);
    try {
      const rows = db.pragma("integrity_check");
      if (rows[0]?.integrity_check !== "ok") problems.push(`db integrity: ${JSON.stringify(rows)}`);
    } finally { db.close(); }
  }

  const mcp = join(config.dataDir, "config/mcp.json");
  if (existsSync(mcp)) {
    try { JSON.parse(require("node:fs").readFileSync(mcp, "utf8")); }
    catch (err) { problems.push(`mcp.json invalid: ${err.message}`); }
  }

  if (problems.length === 0) console.log("doctor: OK");
  else { console.log("doctor: ISSUES"); for (const p of problems) console.log(` - ${p}`); }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/stop.js src/cli/status.js src/cli/doctor.js
git commit -m "feat(cli): stop, status, doctor"
```

---

### Task 25: Vite UI scaffold + config

**Files:**
- Create: `src/ui/index.html`
- Create: `src/ui/vite.config.js`
- Create: `src/ui/src/main.jsx`
- Create: `src/ui/src/App.jsx`
- Create: `src/ui/src/styles.css`

- [ ] **Step 1: `vite.config.js`**

```javascript
// src/ui/vite.config.js
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  plugins: [preact()],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7878",
    },
  },
});
```

- [ ] **Step 2: `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Worklab</title>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 3: `main.jsx`**

```javascript
// src/ui/src/main.jsx
import { render } from "preact";
import { App } from "./App.jsx";

render(<App />, document.getElementById("app"));
```

- [ ] **Step 4: `App.jsx`**

```javascript
// src/ui/src/App.jsx
import { useEffect, useState } from "preact/hooks";
import { Kanban } from "./routes/Kanban.jsx";
import { TaskDetail } from "./routes/TaskDetail.jsx";
import { Settings } from "./routes/Settings.jsx";

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "");
  const [route, ...rest] = h.split("/");
  return { route: route || "tasks", rest };
}

export function App() {
  const [{ route, rest }, setRoute] = useState(parseHash());

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  let body;
  if (route === "tasks" && rest[0]) body = <TaskDetail id={rest[0]} />;
  else if (route === "tasks") body = <Kanban />;
  else if (route === "settings") body = <Settings />;
  else body = <Kanban />;

  return (
    <div class="app">
      <nav class="topnav">
        <a href="#/tasks" class={route === "tasks" ? "active" : ""}>Tasks</a>
        <a href="#/settings" class={route === "settings" ? "active" : ""}>Settings</a>
      </nav>
      <main>{body}</main>
    </div>
  );
}
```

- [ ] **Step 5: `styles.css`**

```css
/* src/ui/src/styles.css */
:root {
  --bg: #0f1115;
  --panel: #171a21;
  --panel-2: #1f242d;
  --text: #e6e9ef;
  --muted: #8a92a3;
  --accent: #5aa1ff;
  --border: #262b35;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
.app { min-height: 100vh; display: flex; flex-direction: column; }
.topnav { display: flex; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
.topnav a { color: var(--muted); text-decoration: none; padding: 4px 8px; border-radius: 4px; }
.topnav a.active { color: var(--text); background: var(--panel-2); }
main { flex: 1; padding: 20px; }
.kanban { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.column { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; min-height: 400px; }
.column h3 { margin: 0 0 12px; text-transform: uppercase; font-size: 12px; color: var(--muted); letter-spacing: 0.08em; }
.task-card { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 10px; margin-bottom: 8px; cursor: grab; }
.task-card:hover { border-color: var(--accent); }
.task-card h4 { margin: 0 0 4px; font-size: 14px; }
.task-card .meta { font-size: 11px; color: var(--muted); }
button, input, textarea { font: inherit; color: inherit; background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; }
button { cursor: pointer; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 20px; min-width: 400px; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.field input, .field textarea { width: 100%; }
.detail { max-width: 800px; margin: 0 auto; }
.comment-list { margin-top: 20px; }
.comment { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 10px; margin-bottom: 8px; }
.comment .author { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
```

- [ ] **Step 6: Build to verify**

```bash
npm run build:ui
```

Expected: `src/ui/dist/index.html` + assets created.

- [ ] **Step 7: Commit**

```bash
git add src/ui/index.html src/ui/vite.config.js src/ui/src/main.jsx src/ui/src/App.jsx src/ui/src/styles.css
git commit -m "feat(ui): vite scaffold + app shell with hash routing"
```

---

### Task 26: UI — API client + SSE hook

**Files:**
- Create: `src/ui/src/lib/api.js`
- Create: `src/ui/src/lib/useSSE.js`

- [ ] **Step 1: API client**

```javascript
// src/ui/src/lib/api.js
async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || res.statusText), { code: json?.error?.code, status: res.status });
  return json;
}

export const api = {
  listTasks: () => request("GET", "/tasks"),
  getTask: (id) => request("GET", `/tasks/${id}`),
  createTask: (data) => request("POST", "/tasks", data),
  patchTask: (id, patch) => request("PATCH", `/tasks/${id}`, patch),
  deleteTask: (id) => request("DELETE", `/tasks/${id}`),
  addComment: (id, body) => request("POST", `/tasks/${id}/comments`, { body }),
  getSettings: () => request("GET", "/settings"),
  patchSettings: (patch) => request("PATCH", "/settings", patch),
};
```

- [ ] **Step 2: SSE hook**

```javascript
// src/ui/src/lib/useSSE.js
import { useEffect } from "preact/hooks";

export function useSSE(channel, onEvent) {
  useEffect(() => {
    const es = new EventSource(`/api/events/stream`);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        onEvent(payload);
      } catch { /* ignore parse errors */ }
    };
    return () => es.close();
  }, [channel]);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/ui/src/lib/api.js src/ui/src/lib/useSSE.js
git commit -m "feat(ui): api client + useSSE hook"
```

---

### Task 27: UI — Kanban board

**Files:**
- Create: `src/ui/src/routes/Kanban.jsx`
- Create: `src/ui/src/components/TaskCard.jsx`
- Create: `src/ui/src/components/NewTaskModal.jsx`

- [ ] **Step 1: `TaskCard.jsx`**

```javascript
// src/ui/src/components/TaskCard.jsx
export function TaskCard({ task, onDragStart }) {
  return (
    <a
      class="task-card"
      href={`#/tasks/${task.id}`}
      draggable
      onDragStart={(e) => onDragStart(e, task)}
    >
      <h4>{task.title}</h4>
      <div class="meta">
        {task.executor_agent ? `exec: ${task.executor_agent}` : "no executor"}
        {task.reviewer_agent ? ` · rev: ${task.reviewer_agent}` : ""}
      </div>
    </a>
  );
}
```

- [ ] **Step 2: `NewTaskModal.jsx`**

```javascript
// src/ui/src/components/NewTaskModal.jsx
import { useState } from "preact/hooks";
import { api } from "../lib/api.js";

export function NewTaskModal({ onClose, onCreated }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const { task } = await api.createTask({ title, description });
      onCreated(task);
    } finally { setBusy(false); }
  }

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New task</h3>
        <form onSubmit={submit}>
          <div class="field">
            <label>Title</label>
            <input autoFocus value={title} onInput={(e) => setTitle(e.target.value)} />
          </div>
          <div class="field">
            <label>Description</label>
            <textarea rows="4" value={description} onInput={(e) => setDescription(e.target.value)} />
          </div>
          <button type="submit" class="primary" disabled={busy || !title.trim()}>Create</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `Kanban.jsx`**

```javascript
// src/ui/src/routes/Kanban.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { TaskCard } from "../components/TaskCard.jsx";
import { NewTaskModal } from "../components/NewTaskModal.jsx";

const COLUMNS = ["todo", "in_progress", "in_review", "done"];
const LABELS = { todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done" };

export function Kanban() {
  const [tasks, setTasks] = useState([]);
  const [showNew, setShowNew] = useState(false);

  const reload = useCallback(() => {
    api.listTasks().then((r) => setTasks(r.tasks));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => {
    if (["task_created", "task_updated", "task_deleted"].includes(evt.type)) reload();
  });

  function onDragStart(e, task) {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
  }

  function onDropColumn(e, status) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/task-id");
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === status) return;
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, status } : t)));  // optimistic
    api.patchTask(id, { status }).catch(() => reload());
  }

  return (
    <>
      <div style="margin-bottom:12px">
        <button class="primary" onClick={() => setShowNew(true)}>+ New task</button>
      </div>
      <div class="kanban">
        {COLUMNS.map((status) => (
          <div
            key={status}
            class="column"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onDropColumn(e, status)}
          >
            <h3>{LABELS[status]}</h3>
            {tasks.filter((t) => t.status === status).map((t) => (
              <TaskCard key={t.id} task={t} onDragStart={onDragStart} />
            ))}
          </div>
        ))}
      </div>
      {showNew && (
        <NewTaskModal
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); reload(); }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 4: Rebuild UI**

```bash
npm run build:ui
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/src/routes/Kanban.jsx src/ui/src/components/TaskCard.jsx src/ui/src/components/NewTaskModal.jsx
git commit -m "feat(ui): kanban with drag-and-drop + new task modal"
```

---

### Task 28: UI — Task detail (view + edit + comments)

**Files:**
- Create: `src/ui/src/routes/TaskDetail.jsx`
- Create: `src/ui/src/components/CommentList.jsx`

- [ ] **Step 1: `CommentList.jsx`**

```javascript
// src/ui/src/components/CommentList.jsx
export function CommentList({ comments }) {
  if (!comments?.length) return <div class="meta">No comments yet.</div>;
  return (
    <div class="comment-list">
      {comments.map((c) => (
        <div key={c.id} class="comment">
          <div class="author">
            {c.author_type} {c.author_id ? `· ${c.author_id}` : ""} ·{" "}
            {new Date(c.created_at).toLocaleString()}
          </div>
          <div>{c.body}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: `TaskDetail.jsx`**

```javascript
// src/ui/src/routes/TaskDetail.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { CommentList } from "../components/CommentList.jsx";

export function TaskDetail({ id }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [newComment, setNewComment] = useState("");

  const reload = useCallback(() => {
    api.getTask(id).then(setData).catch(() => setData({ notFound: true }));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => { if (evt.id === id) reload(); });

  if (!data) return <div>Loading…</div>;
  if (data.notFound) return <div>Task not found. <a href="#/tasks">Back</a></div>;

  const { task, comments } = data;

  async function save() {
    await api.patchTask(id, draft);
    setEditing(false);
  }

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

  return (
    <div class="detail">
      <a href="#/tasks">← Back</a>
      <h2>{task.title}</h2>
      <div class="meta">
        status: {task.status} · created {new Date(task.created_at).toLocaleString()}
      </div>

      {!editing && (
        <>
          <p>{task.description || <span class="meta">No description.</span>}</p>
          <h4>Instructions</h4>
          <pre style="white-space:pre-wrap;background:var(--panel-2);padding:10px;border-radius:6px">{task.instructions || "(none)"}</pre>
          <button onClick={() => { setDraft(task); setEditing(true); }}>Edit</button>
          <button onClick={destroy} style="margin-left:8px;color:#ff7a7a">Delete</button>
        </>
      )}

      {editing && (
        <>
          <div class="field"><label>Title</label><input value={draft.title} onInput={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
          <div class="field"><label>Description</label><textarea rows="4" value={draft.description} onInput={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
          <div class="field"><label>Instructions</label><textarea rows="8" value={draft.instructions} onInput={(e) => setDraft({ ...draft, instructions: e.target.value })} /></div>
          <button class="primary" onClick={save}>Save</button>
          <button onClick={() => setEditing(false)} style="margin-left:8px">Cancel</button>
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

- [ ] **Step 3: Rebuild, commit**

```bash
npm run build:ui
git add src/ui/src/routes/TaskDetail.jsx src/ui/src/components/CommentList.jsx
git commit -m "feat(ui): task detail view + edit + comments"
```

---

### Task 29: UI — Settings page

**Files:**
- Create: `src/ui/src/routes/Settings.jsx`

- [ ] **Step 1: Implement**

```javascript
// src/ui/src/routes/Settings.jsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

export function Settings() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSettings().then((r) => setSettings(r.settings));
  }, []);

  if (!settings) return <div>Loading…</div>;

  async function save() {
    setSaving(true);
    try {
      await api.patchSettings({
        consolidation_hour: Number(settings.consolidation_hour),
        consolidation_enabled: !!settings.consolidation_enabled,
        worker_timeout_ms: Number(settings.worker_timeout_ms),
        cancel_grace_ms: Number(settings.cancel_grace_ms),
        journal_tail_lines: Number(settings.journal_tail_lines),
        kb_pinned_limit: Number(settings.kb_pinned_limit),
      });
    } finally { setSaving(false); }
  }

  return (
    <div class="detail">
      <h2>Settings</h2>
      <div class="field"><label>Consolidation hour (0-23)</label>
        <input type="number" min="0" max="23" value={settings.consolidation_hour}
          onInput={(e) => setSettings({ ...settings, consolidation_hour: e.target.value })} /></div>
      <div class="field"><label>Consolidation enabled</label>
        <input type="checkbox" checked={settings.consolidation_enabled}
          onChange={(e) => setSettings({ ...settings, consolidation_enabled: e.target.checked })} /></div>
      <div class="field"><label>Worker timeout (ms)</label>
        <input type="number" value={settings.worker_timeout_ms}
          onInput={(e) => setSettings({ ...settings, worker_timeout_ms: e.target.value })} /></div>
      <div class="field"><label>Cancel grace (ms)</label>
        <input type="number" value={settings.cancel_grace_ms}
          onInput={(e) => setSettings({ ...settings, cancel_grace_ms: e.target.value })} /></div>
      <button class="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    </div>
  );
}
```

- [ ] **Step 2: Rebuild, commit**

```bash
npm run build:ui
git add src/ui/src/routes/Settings.jsx
git commit -m "feat(ui): settings page"
```

---

### Task 30: E2E smoke test

**Files:**
- Create: `src/__tests__/e2e/smoke.test.js`

- [ ] **Step 1: Write smoke test**

```javascript
// src/__tests__/e2e/smoke.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../api/server.js";
import { getDb, closeDb } from "../../core/db.js";

describe("e2e smoke", () => {
  let http, baseUrl, tmp;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "worklab-e2e-"));
    const db = getDb(join(tmp, "test.db"));
    const { app } = createServer({ db, logger: { info: () => {}, error: () => {}, debug: () => {} } });
    http = createHttpServer(app);
    await new Promise((r) => http.listen(0, r));
    const { port } = http.address();
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await new Promise((r) => http.close(r));
    closeDb();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("full task lifecycle via HTTP", async () => {
    // create
    let res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "smoke task", description: "e2e" }),
    });
    expect(res.status).toBe(201);
    const { task } = await res.json();

    // list
    res = await fetch(`${baseUrl}/api/tasks`);
    const { tasks } = await res.json();
    expect(tasks.some((t) => t.id === task.id)).toBe(true);

    // move through columns
    for (const status of ["in_progress", "in_review", "done"]) {
      res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      expect(res.status).toBe(200);
      const { task: updated } = await res.json();
      expect(updated.status).toBe(status);
    }

    // verify completed_at set
    res = await fetch(`${baseUrl}/api/tasks/${task.id}`);
    const { task: final } = await res.json();
    expect(final.completed_at).toBeTruthy();

    // comment
    res = await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "done!" }),
    });
    expect(res.status).toBe(201);

    // delete
    res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run**

```bash
npm test src/__tests__/e2e/smoke.test.js
```

Expected: PASS.

- [ ] **Step 3: Run full suite + coverage**

```bash
npm run test:coverage
```

Expected: all tests pass, coverage thresholds met for `src/core/` (state-machine 100% line+branch; others ≥60%).

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/e2e/smoke.test.js
git commit -m "test(e2e): full task lifecycle smoke"
```

---

### Task 31: Manual end-to-end check

- [ ] **Step 1: Build UI**

```bash
cd /opt/claude-workspace/local/worklab
npm run build:ui
```

- [ ] **Step 2: Start coordinator**

```bash
npm start
```

Expected: log line "coordinator listening" with port 7878.

- [ ] **Step 3: Open browser**

`http://localhost:7878`

- [ ] **Step 4: Verify by hand**
  - Create a task via "+ New task" modal.
  - Drag it from "To do" → "In progress" → "In review" → "Done".
  - Click into the task, edit the title and description, save.
  - Add two comments.
  - Open a second tab on the same URL and confirm edits in one tab appear in the other within ~1s (SSE).
  - Drag the Done task back to "To do", confirm it moves.
  - Delete the task.
  - Visit `#/settings`, change consolidation_hour to 4, save, refresh, confirm persistence.

- [ ] **Step 5: Verify CLI**

```bash
# In another terminal:
./src/cli/index.js status
./src/cli/index.js doctor
./src/cli/index.js stop
./src/cli/index.js status    # should show "not running"
```

- [ ] **Step 6: Commit any fix-ups**

If anything breaks in manual testing, fix, retest, commit. If everything works, no commit needed.

- [ ] **Step 7: Tag phase-1**

```bash
git tag phase-1
```

---

## Verification

**Automated tests** — all of the following must pass:
```bash
cd /opt/claude-workspace/local/worklab
npm run test:coverage
```
- All unit tests pass (db, state-machine, config, ids, first-boot, sse).
- All API tests pass (routes-tasks, routes-settings, routes-activity).
- E2E smoke passes.
- Coverage thresholds met (60% lines; state-machine 100%).

**Manual UI flow** — per Task 31 steps 4 & 5.

**CLI** — `start`, `stop`, `status`, `doctor` all work as described.

---

## What Phase 2 will add (not in this plan)

Separate plan doc (`docs/superpowers/plans/YYYY-MM-DD-worklab-phase-2.md`) will cover:
- Claude Agent SDK integration (`src/core/ai.js`, `src/core/ai-claude.js`)
- Worker binary (`src/worker.js`) with execute mode
- Agents CRUD (routes + UI)
- Skills loader + UI
- MCP config loader + built-in `worklab-tools` MCP server
- Journal append MCP tool
- Coordinator task-watcher + spawn-worker demux
- Live SSE event streaming of SDK events in task detail view
- SIGTERM/SIGKILL cancellation

Write that plan after Phase 1 is merged, tagged, and you've driven it by hand.

---

## Self-review checklist (completed by plan author)

- **Spec coverage (§8 Phase 1 deliverables):** scaffold ✓ (Task 1), db.js ✓ (Tasks 6-7), logger.js ✓ (Task 3), config.js ✓ (Task 4), coordinator.js ✓ (Task 22), server.js ✓ (Task 15), sse.js ✓ (Task 14), routes-tasks ✓ (Tasks 16-19), routes-settings ✓ (Task 20), routes-activity ✓ (Task 21), state-machine.js + full coverage ✓ (Tasks 9-13), UI Kanban+TaskDetail+Settings ✓ (Tasks 25-29), CLI start/stop/status/doctor ✓ (Tasks 23-24), first-boot seeding ✓ (Task 8), .gitignore rules ✓ (Task 1).
- **Placeholders:** none (no TBD/TODO strings, every code block has full code).
- **Type consistency:** `rowToTask` returns same shape in all uses; `nextStatus(current, event)` signature is identical across tasks; `createServer({db, logger})` signature matches usage in coordinator and test-server.
- **Acceptance criteria from spec §8 Phase 1:** `worklab start` boots ✓ (Tasks 22-23 + manual Task 31), UI loads ✓, tasks CRUD ✓, state-machine 100% coverage ✓ (Task 13), `worklab doctor` reports OK ✓ (Task 24), kanban DnD ✓ (Task 27), two-tab SSE sync ✓ (Task 27 via useSSE + Task 31 manual check).
