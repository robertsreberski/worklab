import { backendCapabilities } from "./backend.js";
import { generatePiResponse } from "./ai-pi.js";

export async function generateOpenAIResponse(systemPrompt, options = {}) {
  const model = options.model?.sdk
    ? options.model
    : { sdk: "openai", model: options.model?.model || options.model, reference: `openai:${options.model?.model || options.model}` };
  return generatePiResponse(systemPrompt, { ...options, model });
}

export const openAiSdkBackend = {
  kind: "openai",
  capabilities: backendCapabilities("openai"),
  execute: generateOpenAIResponse,
};
