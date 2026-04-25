import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

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

export function getBuiltinProviderAvailability({
  env = process.env,
  path = env.PATH ?? process.env.PATH ?? "",
  execImpl = execFileSync,
} = {}) {
  const claudeEnv = !!(env.ANTHROPIC_API_KEY
    || env.ANTHROPIC_AUTH_TOKEN
    || env.CLAUDE_CODE_OAUTH_TOKEN);
  const openaiEnv = !!env.OPENAI_API_KEY;
  const claudeCli = commandOnPath("claude", path);
  const codexCli = commandOnPath("codex", path);
  const probeEnv = { ...process.env, ...env, PATH: path };
  const claudeVersion = claudeCli ? cleanVersion(runProbe(execImpl, "claude", ["--version"], { timeoutMs: 1200, env: probeEnv }).output) : null;
  const codexVersion = codexCli ? cleanVersion(runProbe(execImpl, "codex", ["--version"], { timeoutMs: 1200, env: probeEnv }).output) : null;
  const claudeCodeAuth = claudeAuthAvailable({ env: probeEnv, commandAvailable: claudeCli, execImpl });
  const codexAuth = codexAuthAvailable({ env: probeEnv, commandAvailable: codexCli, execImpl });
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
      runtime_kind: "sdk",
      auth: openaiEnv ? "env" : "missing-auth",
    },
    "claude-code": {
      available: claudeCli && claudeCodeAuth.available,
      reason: claudeCli ? claudeCodeAuth.reason : "Install Claude Code and ensure `claude` is on PATH.",
      runtime_kind: "cli",
      command: "claude",
      command_available: claudeCli,
      version: claudeVersion,
      auth: claudeCodeAuth.auth,
    },
    codex: {
      available: codexCli && codexAuth.available,
      reason: codexCli ? codexAuth.reason : "Install Codex CLI and ensure `codex` is on PATH.",
      runtime_kind: "cli",
      command: "codex",
      command_available: codexCli,
      version: codexVersion,
      auth: codexAuth.auth,
    },
  };
}
