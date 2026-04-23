import { getBuiltinModelGroups } from "../core/ai.js";
import { buildModelCapabilities, isValidProviderType, listModels, listProviders } from "../core/providers.js";
import { getBuiltinProviderAvailability } from "../core/credentials.js";

const OPENAI_EMBEDDING_MODELS = [
  { model: "text-embedding-3-small", label: "text-embedding-3-small", description: "1536 dims, low cost" },
  { model: "text-embedding-3-large", label: "text-embedding-3-large", description: "3072 dims, higher quality" },
  { model: "text-embedding-ada-002", label: "text-embedding-ada-002", description: "Legacy, 1536 dims" },
];

export function registerModelRoutes(app, { db, dataDir }) {
  app.get("/api/models/available", (_req, res) => {
    const groups = getBuiltinModelGroups();
    const availability = getBuiltinProviderAvailability();
    for (const group of groups) {
      const avail = availability[group.id];
      if (avail) {
        group.available = avail.available;
        group.unavailable_reason = avail.reason;
      }
    }

    for (const provider of listProviders({ db, dataDir, enabledOnly: true })) {
      if (!isValidProviderType(provider.provider_type)) continue;
      const models = listModels({ db, providerId: provider.id, enabledOnly: true }).flatMap((model) => {
        const capabilities = buildModelCapabilities(provider.provider_type, model.model_name, model.capabilities);
        if (!capabilities.runnable_for_agent) return [];
        return [{
          value: `vercel:${provider.id}:${model.model_name}`,
          label: model.display_name || model.model_name,
          description: `${provider.name} / ${model.model_name}`,
          sdk: "vercel",
          provider_id: provider.id,
          provider_name: provider.name,
          provider_type: provider.provider_type,
          model_name: model.model_name,
          capabilities,
          builtin_tools: capabilities.builtin_tools,
          supports_builtin_tools: capabilities.supports_builtin_tools,
          pricing: model.pricing,
        }];
      });
      if (models.length) {
        groups.push({
          id: provider.id,
          label: provider.name,
          provider_type: provider.provider_type,
          available: true,
          unavailable_reason: null,
          models,
        });
      }
    }

    res.json({ groups, models: groups.flatMap((group) => group.models) });
  });

  app.get("/api/models/embeddings", (_req, res) => {
    const availability = getBuiltinProviderAvailability();
    const groups = [{
      id: "openai",
      label: "OpenAI",
      available: availability.openai.available,
      unavailable_reason: availability.openai.reason,
      models: OPENAI_EMBEDDING_MODELS.map((m) => ({
        value: `openai:${m.model}`,
        label: m.label,
        description: m.description,
      })),
    }];

    for (const provider of listProviders({ db, dataDir, enabledOnly: true })) {
      if (!isValidProviderType(provider.provider_type)) continue;
      const embeddingModels = listModels({ db, providerId: provider.id, enabledOnly: true }).filter((m) => {
        const caps = m.capabilities || {};
        return caps.embedding === true || /embed/i.test(m.model_name);
      });
      if (!embeddingModels.length) continue;
      groups.push({
        id: provider.id,
        label: provider.name,
        provider_type: provider.provider_type,
        available: true,
        unavailable_reason: null,
        models: embeddingModels.map((m) => ({
          value: `vercel:${provider.id}:${m.model_name}`,
          label: m.display_name || m.model_name,
          description: `${provider.name} / ${m.model_name}`,
        })),
      });
    }

    res.json({ groups });
  });
}
