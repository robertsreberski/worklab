import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

function commandOnPath(command) {
  const path = process.env.PATH || "";
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

export function getBuiltinProviderAvailability() {
  const claudeEnv = !!(process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const openaiEnv = !!process.env.OPENAI_API_KEY;
  const claudeCli = commandOnPath("claude");
  const codexCli = commandOnPath("codex");
  return {
    claude: {
      available: claudeEnv,
      reason: claudeEnv ? null : "Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN.",
    },
    openai: {
      available: openaiEnv,
      reason: openaiEnv ? null : "Set OPENAI_API_KEY.",
    },
    "claude-code": {
      available: claudeCli,
      reason: claudeCli ? null : "Install Claude Code and ensure `claude` is on PATH.",
    },
    codex: {
      available: codexCli,
      reason: codexCli ? null : "Install Codex CLI and ensure `codex` is on PATH.",
    },
  };
}
