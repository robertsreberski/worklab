export function getBuiltinProviderAvailability() {
  const claudeEnv = !!(process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const openaiEnv = !!process.env.OPENAI_API_KEY;
  return {
    claude: {
      available: claudeEnv,
      reason: claudeEnv ? null : "Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN.",
    },
    openai: {
      available: openaiEnv,
      reason: openaiEnv ? null : "Set OPENAI_API_KEY.",
    },
  };
}
