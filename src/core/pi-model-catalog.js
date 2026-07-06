import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const piModels = builtinModels();

export function getPiModels(provider) {
  return piModels.getModels(provider);
}

export function getPiModel(provider, modelId) {
  const model = piModels.getModel(provider, modelId);
  if (!model) throw new Error(`unknown Pi model: ${provider}:${modelId}`);
  return model;
}
