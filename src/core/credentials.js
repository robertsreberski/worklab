import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { hasPiOAuthCredentials } from "../ai/pi-oauth.js";

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
  execImpl = null,
  dataDir = null,
} = {}) {
  const claudeEnv = !!(env.ANTHROPIC_API_KEY
    || env.ANTHROPIC_AUTH_TOKEN
    || env.CLAUDE_CODE_OAUTH_TOKEN);
  const openaiEnv = !!env.OPENAI_API_KEY;
  const probeEnv = { ...process.env, ...env, PATH: path };
  const codexAuth = piAuthAvailable("openai-codex", { env: probeEnv, dataDir });
  const codexCliAvailable = commandOnPath("codex", path);
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
      runtime_kind: "embedding",
      auth: openaiEnv ? "env" : "missing-auth",
    },
    "pi:openai": {
      available: openaiEnv,
      reason: openaiEnv ? null : "Set OPENAI_API_KEY.",
      runtime_kind: "pi-agent",
      auth: openaiEnv ? "env" : "missing-auth",
    },
    "pi:openai-codex": {
      available: codexAuth.available,
      reason: codexAuth.reason,
      runtime_kind: "pi-agent",
      auth: codexAuth.auth,
    },
    codex: {
      available: codexCliAvailable,
      reason: codexCliAvailable ? null : "Install or add the codex CLI to PATH.",
      runtime_kind: "cli",
      auth: codexCliAvailable ? "codex-cli" : "missing-command",
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
