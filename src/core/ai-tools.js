import { getPiBuiltinTools } from "./ai-pi-tools.js";

export function getOpenAITools(allowedTools, { skillNames = [], dataDir, cwd, onEvent } = {}) {
  return getPiBuiltinTools(allowedTools, { skillNames, dataDir, cwd, onEvent });
}
