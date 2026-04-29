import { backendCapabilities } from "./backend.js";
import { generatePiResponse } from "./ai-pi.js";

export async function generateVercelResponse(systemPrompt, options = {}) {
  return generatePiResponse(systemPrompt, options);
}

export const vercelSdkBackend = {
  kind: "vercel",
  capabilities: backendCapabilities("vercel"),
  execute: generateVercelResponse,
};
