import { getPiBuiltinTools } from "./ai-pi-tools.js";

export function getVercelTools({ allowedTools, skillNames = [], dataDir, cwd, onEvent } = {}) {
  return Object.fromEntries(
    getPiBuiltinTools(allowedTools, { skillNames, dataDir, cwd, onEvent }).map((tool) => [tool.name, tool]),
  );
}
