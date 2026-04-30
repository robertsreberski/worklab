// Module-boundary lint for the modularization plan.
//
// Rules are at "warn" until Phase 7. Today many violations exist (api/integrations
// touching better-sqlite3, slack reaching into core, etc.). The warnings document
// what each phase needs to clean up; nothing fails until we promote to "error".
//
// Layout the rules target (some directories don't exist yet — rules activate as we create them):
//   src/ai/        provider layer; no DB, no domain layers
//   src/agent/     agent kernel; may use src/ai/ only
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

const FORBID_DOMAIN_LAYERS = {
  group: [
    "**/core/**",
    "**/coordinator/**",
    "**/coordinator.js",
    "**/api/**",
    "**/mcp/**",
    "**/integrations/**",
    "**/cli/**",
    "**/worker.js",
    "**/worker/**",
  ],
  message: "Provider/kernel layers must not depend on Worklab domain or edge layers.",
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

const restricted = (...patterns) => ({
  "no-restricted-imports": ["warn", { patterns }],
});

// API routes must call helpers in src/core/db/queries/*.js, not db.prepare directly.
// CLAUDE.md declares this invariant; this rule actually enforces it.
const FORBID_API_DB_PREPARE = {
  "no-restricted-syntax": [
    "warn",
    {
      selector: "CallExpression[callee.object.name='db'][callee.property.name='prepare']",
      message:
        "API routes must call helpers in src/core/db/queries/*.js, not db.prepare directly.",
    },
  ],
};

export default [
  {
    ignores: [
      "node_modules/**",
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

  // src/ai/ — provider layer
  {
    files: ["src/ai/**/*.js"],
    rules: restricted(FORBID_DB, FORBID_DOMAIN_LAYERS),
  },

  // src/agent/ — kernel
  {
    files: ["src/agent/**/*.js"],
    rules: restricted(FORBID_DB, FORBID_DOMAIN_LAYERS),
  },

  // src/core/ — domain (DB allowed inside src/core/db/**)
  {
    files: ["src/core/**/*.js"],
    ignores: ["src/core/db/**"],
    rules: restricted(FORBID_DB, FORBID_EDGE_FROM_CORE),
  },

  // src/api/ — HTTP edge
  {
    files: ["src/api/**/*.js"],
    rules: { ...restricted(FORBID_DB), ...FORBID_API_DB_PREPARE },
  },

  // src/mcp/ — MCP edge
  {
    files: ["src/mcp/**/*.js"],
    rules: restricted(FORBID_DB, {
      group: ["**/api/**", "**/integrations/**", "**/cli/**"],
      message: "MCP servers depend on core/agent/ai only.",
    }),
  },

  // src/integrations/ — external integrations
  {
    files: ["src/integrations/**/*.js"],
    rules: restricted(FORBID_DB, FORBID_API_LAYER),
  },

  // src/cli/ — binary subcommands
  {
    files: ["src/cli/**/*.js"],
    rules: restricted({
      group: ["**/api/**", "**/integrations/**", "**/mcp/**"],
      message: "CLI uses core and coordinator only.",
    }),
  },

  // Tests, UI bundle source, generated/legacy: no boundary checks
  {
    files: ["src/__tests__/**", "src/ui/**", "src/playwright/**"],
    rules: { "no-restricted-imports": "off" },
  },
];
