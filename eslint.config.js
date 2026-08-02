// Module-boundary lint for the modularization plan.
//
// All rules are at "error" level. PR-2..PR-6 cleared the db.prepare()
// violations in src/api/**, PR-13..PR-15 + the PR-14 follow-on cleared every
// cross-layer back-import, and PR-9 added the FORBID_DEEP_CORE rule that
// requires edge layers to consume domain helpers via the public core barrel
// (src/core/index.js). The carve-outs are documented inline below.
//
// The provider layer and agent kernel now live in the external
// @mono-agent/agent-runtime npm package, so they carry their own boundary
// rules; only Worklab's own layers are covered here.
//
// Layout the rules target:
//   src/core/      domain; no edge-layer imports; DB only inside src/core/db/**
//   src/api/       HTTP edge; no direct DB
//   src/mcp/       MCP edge; no direct DB; no api/integrations/cli imports
//   src/integrations/ external integrations; no api imports; no direct DB
//   src/cli/       binary; uses core/coordinator only
//   src/coordinator/ may use core/agent/ai
//   src/worker/    may use core/agent/ai

import globals from "globals";

const FORBID_DB = {
  group: ["better-sqlite3"],
  message: "Direct DB access is restricted to src/core/db/**.",
};

const FORBID_API_LAYER = {
  group: ["**/api/**"],
  message: "This layer must not depend on src/api/.",
};

const FORBID_CLI_LAYER = {
  group: ["**/cli/**"],
  message: "HTTP/API and service layers must not depend on src/cli/.",
};

const FORBID_REMOVED_SHIMS = {
  group: [
    "**/core/agent-allowlists.js",
    "**/core/agent-compaction.js",
    "**/core/ai-claude.js",
    "**/core/ai-cli.js",
    "**/core/ai-codex-app.js",
    "**/core/ai-pi.js",
    "**/core/ai-tool-helpers.js",
    "**/core/codex-events.js",
    "**/core/context.js",
    "**/core/db.js",
    "**/core/failure-kind.js",
    "**/core/run-transcript.js",
    "**/core/schema.js",
    "**/core/worklab-result.js",
    "**/mcp/admin/tools.js",
    "**/mcp/agent/tools.js",
  ],
  message: "Compatibility shims were removed; import the canonical ai/agent/core/db/mcp module.",
};

// agent-runtime owns the Pi dependency (mono-agent#544). Production code goes
// through the runtime façade on @mono-agent/agent-runtime/ai —
// listPiBuiltinModels, getPiBuiltinModel, reasoningLevelsForPiModel,
// resolvePiOAuthApiKey, loginPiOAuth — which keeps pi-ai's mutable registry and
// its exact 0.83.0 pin inside the runtime. pi-ai remains a devDependency only
// for the faux-provider fixtures in src/__tests__/e2e/multi-sdk.test.js, so the
// test blocks below deliberately do not carry this rule.
const FORBID_PI_AI = {
  group: ["@earendil-works/*"],
  message:
    "Import Pi catalog/OAuth helpers from @mono-agent/agent-runtime/ai; pi-ai is a test-only dependency.",
};

const FORBID_EDGE_FROM_CORE = {
  group: [
    "**/coordinator/**",
    "**/coordinator.js",
    "**/api/**",
    "**/mcp/**",
    "**/integrations/**",
    "**/cli/**",
    "**/worker.js",
    "**/worker/**",
  ],
  message: "src/core/ must not depend on coordinator/api/mcp/integrations/cli/worker.",
};

// Boundary rules at error level. New deep core/* imports outside the
// documented carve-outs (src/coordinator/task-watcher.js,
// coordinator/watcher/*.js, coordinator/spawn-worker.js) fail npm run lint
// and the pre-commit guard.
const restricted = (...patterns) => ({
  "no-restricted-imports": ["error", { patterns }],
});

// API routes must call helpers in src/core/db/queries/*.js, not db.prepare directly.
// PR-1 introduced this at "warn" while PR-2..PR-6 migrated the 100 existing
// sites; PR-7 flipped it to "error". CLAUDE.md states this invariant.
const FORBID_API_DB_PREPARE = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "CallExpression[callee.object.name='db'][callee.property.name='prepare']",
      message:
        "API routes must call helpers in src/core/db/queries/*.js, not db.prepare directly.",
    },
  ],
};

// PR-9: edge layers must consume core/ via the public barrel (src/core/index.js)
// rather than reaching into individual core modules. The exceptions documented
// alongside PR-9:
//   - api/routes/* may import from src/core/db/queries/* (the agreed pattern after
//     PR-2..PR-6 migrated raw db.prepare calls into named query helpers).
//   - coordinator/task-watcher.js, coordinator/watcher/*.js, and
//     coordinator/spawn-worker.js are internal coordinator plumbing and may keep
//     deep imports.
// no-restricted-imports patterns are matched with .gitignore semantics (the
// `ignore` package), which doesn't support extended-glob !(...) — we use
// allow-listed re-includes instead.
// Edge layers consume core/ via the public barrel (src/core/index.js).
// Domain barrels under core/{workflow,runtime,content,platform}/index.js are
// also public seams for incremental modularization.
// core/db/queries/* is explicitly allowed everywhere — the named query
// helpers are the agreed cross-cutting DAL after PR-2..PR-6 migrated all
// raw db.prepare() calls. (Routes were the original beneficiary; same
// pattern applies wherever a non-test consumer needs DB access.)
const FORBID_DEEP_CORE = {
  group: [
    "**/core/**",
    "!**/core/index*",
    "!**/core/db",
    "!**/core/db/index*",
    "!**/core/db/queries",
    "!**/core/db/queries/**",
    "!**/core/workflow",
    "!**/core/workflow/index*",
    "!**/core/runtime",
    "!**/core/runtime/index*",
    "!**/core/content",
    "!**/core/content/index*",
    "!**/core/platform",
    "!**/core/platform/index*",
  ],
  message:
    "Import from a core public barrel; core/db/queries/* is the only non-barrel deep import allowed.",
};

export default [
  {
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      "src/ui/dist/**",
      "test-results/**",
      "data-template/**",
      "**/*.min.js",
    ],
  },
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

  // src/core/ — domain (DB allowed inside src/core/db/**)
  {
    files: ["src/core/**/*.js"],
    ignores: ["src/core/db/**"],
    rules: restricted(FORBID_DB, FORBID_EDGE_FROM_CORE, FORBID_REMOVED_SHIMS, FORBID_PI_AI),
  },

  // src/api/ — HTTP edge. Edge consumers go through core/index.js; the
  // FORBID_DEEP_CORE carve-out for core/db/queries/* applies here too.
  {
    files: ["src/api/**/*.js"],
    rules: {
      ...restricted(FORBID_DB, FORBID_DEEP_CORE, FORBID_CLI_LAYER, FORBID_REMOVED_SHIMS, FORBID_PI_AI),
      ...FORBID_API_DB_PREPARE,
    },
  },

  // src/mcp/ — MCP edge
  {
    files: ["src/mcp/**/*.js"],
    rules: restricted(FORBID_DB, FORBID_DEEP_CORE, FORBID_REMOVED_SHIMS, FORBID_PI_AI, {
      group: ["**/api/**", "**/integrations/**", "**/cli/**"],
      message: "MCP servers depend on core/agent/ai only.",
    }),
  },

  // src/integrations/ — external integrations
  {
    files: ["src/integrations/**/*.js"],
    rules: restricted(FORBID_DB, FORBID_DEEP_CORE, FORBID_API_LAYER, FORBID_REMOVED_SHIMS, FORBID_PI_AI),
  },

  // src/cli/ — binary subcommands.
  {
    files: ["src/cli/**/*.js"],
    rules: restricted(FORBID_DEEP_CORE, FORBID_REMOVED_SHIMS, FORBID_PI_AI, {
      group: ["**/api/**", "**/integrations/**", "**/mcp/**"],
      message: "CLI uses core and coordinator only.",
    }),
  },

  // src/coordinator/ + src/coordinator.js + src/worker.js — process orchestration.
  // task-watcher.js, watcher/*.js, and spawn-worker.js are explicitly carved out
  // below; they need internal coordinator plumbing access to core internals.
  {
    files: [
      "src/coordinator.js",
      "src/coordinator/automation-manager.js",
      "src/coordinator/consolidation-cron.js",
      "src/coordinator/search-indexer.js",
      "src/worker.js",
    ],
    rules: restricted(FORBID_DEEP_CORE, FORBID_REMOVED_SHIMS, FORBID_PI_AI),
  },

  // The coordinator/worker internals carved out of FORBID_DEEP_CORE above keep
  // their deep core access, but the pi-ai ban applies to every production file.
  {
    files: ["src/coordinator/**/*.js", "src/worker/**/*.js"],
    ignores: [
      "src/coordinator/automation-manager.js",
      "src/coordinator/consolidation-cron.js",
      "src/coordinator/search-indexer.js",
    ],
    rules: restricted(FORBID_PI_AI),
  },

  // Tests, UI bundle source, generated/legacy: no boundary checks
  {
    files: ["src/__tests__/**", "src/ui/**", "src/playwright/**"],
    rules: { "no-restricted-imports": "off" },
  },

  // Tests are exempt from boundary layering, but deleted compatibility paths
  // should not creep back in. UI JSX is covered by the build plus reference
  // scans because this ESLint config does not parse JSX.
  {
    files: ["src/__tests__/**/*.js"],
    rules: restricted(FORBID_REMOVED_SHIMS),
  },
];
