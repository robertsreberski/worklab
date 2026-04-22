import { getBuiltinModelGroups } from "../core/ai.js";
import { buildModelCapabilities, isValidProviderType, listModels, listProviders } from "../core/providers.js";

export function registerModelRoutes(app, { db, dataDir }) {
  app.get("/api/models/available", (_req, res) => {
    const groups = getBuiltinModelGroups();

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
        groups.push({ id: provider.id, label: provider.name, provider_type: provider.provider_type, models });
      }
    }

    res.json({ groups, models: groups.flatMap((group) => group.models) });
  });
}
