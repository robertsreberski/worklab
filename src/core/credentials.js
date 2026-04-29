import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { hasPiOAuthCredentials } from "./pi-oauth.js";

const PROBE_TTL_MS = 10_000;
const probeCache = new Map();

export function commandOnPath(command, pathValue = process.env.PATH || "") {
  const path = pathValue || "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // keep scanning PATH
    }
  }
  return false;
}

function runProbe(execImpl, command, args, { timeoutMs = 1200, env = process.env } = {}) {
  const cacheKey = execImpl === execFileSync
    ? `${command}\0${args.join("\0")}\0${env.PATH || ""}`
    : null;
  if (cacheKey) {
    const cached = probeCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < PROBE_TTL_MS) return cached.value;
  }
  try {
    const output = execImpl(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      env,
    });
    const value = { ok: true, output: String(output || "").trim(), error: null };
    if (cacheKey) probeCache.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : "";
    const stdout = err?.stdout ? String(err.stdout).trim() : "";
    const value = {
      ok: false,
      output: stdout,
      error: stderr || stdout || err?.message || String(err),
    };
    if (cacheKey) probeCache.set(cacheKey, { ts: Date.now(), value });
    return value;
  }
}

function cleanVersion(text) {
  const first = String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first || null;
}

function claudeAuthAvailable({ env, commandAvailable, execImpl }) {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { available: true, auth: "env", reason: null };
  }
  if (!commandAvailable) {
    return { available: false, auth: "missing-command", reason: "Install Claude Code and ensure `claude` is on PATH." };
  }
  const auth = runProbe(execImpl, "claude", ["auth", "status", "--text"], { timeoutMs: 1200, env });
  if (auth.ok) return { available: true, auth: "login", reason: null };
  return {
    available: false,
    auth: "missing-auth",
    reason: "Run `claude auth login` or set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN.",
  };
}

function codexAuthAvailable({ env, commandAvailable, execImpl }) {
  if (env.CODEX_API_KEY || env.OPENAI_API_KEY) {
    return { available: true, auth: env.CODEX_API_KEY ? "codex_api_key" : "openai_api_key", reason: null };
  }
  if (!commandAvailable) {
    return { available: false, auth: "missing-command", reason: "Install Codex CLI and ensure `codex` is on PATH." };
  }
  const auth = runProbe(execImpl, "codex", ["login", "status"], { timeoutMs: 1200, env });
  if (auth.ok) return { available: true, auth: "login", reason: null };
  return {
    available: false,
    auth: "missing-auth",
    reason: "Run `codex login` or set CODEX_API_KEY for `codex exec`.",
  };
}

const PI_ENV_KEYS = {
  openai: ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_CODEX_API_KEY", "CODEX_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  google: ["GEMINI_API_KEY"],
  "google-gemini-cli": ["GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
};

function piAuthAvailable(provider, { env, dataDir }) {
  const keys = PI_ENV_KEYS[provider] || [];
  const found = keys.find((key) => env[key]);
  if (found) return { available: true, auth: found.toLowerCase(), reason: null };
  if (hasPiOAuthCredentials(provider, { dataDir, env })) {
    return { available: true, auth: "pi-oauth", reason: null };
  }
  const first = keys[0];
  const reason = first
    ? `Set ${first}${provider === "openai-codex" ? " or authenticate pi-ai OpenAI Codex OAuth." : "."}`
    : `Authenticate provider ${provider} for pi-ai.`;
  return { available: false, auth: "missing-auth", reason };
}

export function getBuiltinProviderAvailability({
  env = process.env,
  path = env.PATH ?? process.env.PATH ?? "",
  execImpl = execFileSync,
  dataDir = null,
} = {}) {
  const claudeEnv = !!(env.ANTHROPIC_API_KEY
    || env.ANTHROPIC_AUTH_TOKEN
    || env.CLAUDE_CODE_OAUTH_TOKEN);
  const openaiEnv = !!env.OPENAI_API_KEY;
  const claudeCli = commandOnPath("claude", path);
  const probeEnv = { ...process.env, ...env, PATH: path };
  const claudeVersion = claudeCli ? cleanVersion(runProbe(execImpl, "claude", ["--version"], { timeoutMs: 1200, env: probeEnv }).output) : null;
  const claudeCodeAuth = claudeAuthAvailable({ env: probeEnv, commandAvailable: claudeCli, execImpl });
  const codexAuth = piAuthAvailable("openai-codex", { env: probeEnv, dataDir });
  const piProviders = [
    "github-copilot",
    "google-gemini-cli",
    "google",
    "deepseek",
    "groq",
    "mistral",
    "xai",
    "openrouter",
    "vercel-ai-gateway",
  ];
  const piAvailability = Object.fromEntries(piProviders.map((provider) => {
    const auth = piAuthAvailable(provider, { env: probeEnv, dataDir });
    return [`pi:${provider}`, {
      available: auth.available,
      reason: auth.reason,
      runtime_kind: "pi-agent",
      auth: auth.auth,
    }];
  }));
  return {
    claude: {
      available: claudeEnv,
      reason: claudeEnv ? null : "Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN.",
      runtime_kind: "sdk",
      auth: claudeEnv ? "env" : "missing-auth",
    },
    openai: {
      available: openaiEnv,
      reason: openaiEnv ? null : "Set OPENAI_API_KEY.",
      runtime_kind: "pi-agent",
      auth: openaiEnv ? "env" : "missing-auth",
    },
    "claude-code": {
      available: claudeEnv || claudeCodeAuth.available,
      reason: claudeEnv ? null : claudeCodeAuth.reason,
      runtime_kind: "sdk",
      command: claudeCli ? "claude" : null,
      command_available: claudeCli,
      version: claudeVersion,
      auth: claudeEnv ? "env" : claudeCodeAuth.auth,
    },
    codex: {
      available: codexAuth.available,
      reason: codexAuth.reason,
      runtime_kind: "pi-agent",
      auth: codexAuth.auth,
    },
    pi: {
      available: true,
      reason: null,
      runtime_kind: "pi-agent",
      auth: "provider-specific",
    },
    ...piAvailability,
  };
}
