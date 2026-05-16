import { getModel as getPiModel } from "@earendil-works/pi-ai";
import { readRuntimeBrand } from "../../agent/tools/shared/runtime-context.js";

export const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function rootUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "").replace(/\/(api|v1)$/, "");
}

function openAiCompatBaseUrl(provider) {
  const baseUrl = String(provider?.base_url || "").replace(/\/+$/, "");
  if (provider?.provider_type === "ollama") return `${rootUrl(baseUrl)}/v1`;
  return /\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}

function customProviderName(provider) {
  return `${readRuntimeBrand().providerModelPrefix}-${provider.id}`;
}

function customProviderKey(provider, isPrivate) {
  if (provider?.api_key) return provider.api_key;
  return isPrivate ? "ollama" : "";
}

function customCompat(capabilities, isPrivate) {
  return {
    supportsStore: false,
    supportsDeveloperRole: !isPrivate,
    supportsReasoningEffort: capabilities?.reasoning_mode === "effort",
    maxTokensField: "max_tokens",
  };
}

// Build the pi-runtime view of a custom provider/model from
// pre-resolved primitives. The caller (core/ai.js#generateResponse) reads
// the provider/model rows and computes the capabilities + isPrivate flag
// before invoking the provider, so this function never reaches into the
// domain layer.
function resolveCustomPiModel(resolved, options) {
  const provider = options.customProvider;
  if (!provider) {
    throw new Error(
      `pi custom provider context missing for ${resolved.provider}: caller must pass options.customProvider`,
    );
  }
  if (!provider.enabled) throw new Error(`provider disabled: ${resolved.provider}`);
  const modelRow = options.customModel || null;
  if (modelRow && modelRow.enabled === false) {
    throw new Error(`model disabled: ${resolved.model}`);
  }
  const capabilities = options.modelCapabilities;
  if (!capabilities || typeof capabilities !== "object") {
    throw new Error(
      `pi custom model capabilities missing for ${resolved.model}: caller must pass options.modelCapabilities`,
    );
  }
  const isPrivate = typeof options.isPrivateProvider === "boolean"
    ? options.isPrivateProvider
    : false;
  const providerName = customProviderName(provider);
  const pricing = modelRow?.pricing || {};
  return {
    model: {
      id: resolved.model,
      name: modelRow?.display_name || resolved.model,
      api: "openai-completions",
      provider: providerName,
      baseUrl: openAiCompatBaseUrl(provider),
      reasoning: !!capabilities.reasoning,
      input: capabilities.vision === false ? ["text"] : ["text", "image"],
      cost: {
        input: Number(pricing.input_per_million) || 0,
        output: Number(pricing.output_per_million) || 0,
        cacheRead: Number(pricing.cached_input_per_million) || 0,
        cacheWrite: Number(pricing.cache_write_per_million) || 0,
      },
      contextWindow: Number(capabilities.context_window || capabilities.num_ctx) || 128000,
      maxTokens: Number(capabilities.max_tokens) || 16384,
      compat: customCompat(capabilities, isPrivate),
    },
    capabilities,
    apiKeys: new Map([[providerName, customProviderKey(provider, isPrivate)]]),
  };
}

export function resolvePiRuntimeModel(resolved, options) {
  if (options.customProvider) return resolveCustomPiModel(resolved, options);
  if (resolved.sdk !== "pi") throw new Error(`unsupported pi sdk: ${resolved.sdk}`);
  const provider = resolved.provider;
  const model = getPiModel(provider, resolved.model);
  return {
    model,
    capabilities: {
      tool_use: true,
      reasoning: !!model.reasoning,
      reasoning_mode: model.reasoning ? "effort" : "none",
      reasoning_levels: model.reasoning ? ["none", "low", "medium", "high", "xhigh"] : undefined,
      reasoning_disable_supported: true,
      vision: Array.isArray(model.input) ? model.input.includes("image") : false,
      json_mode: true,
    },
    apiKeys: new Map(),
  };
}
