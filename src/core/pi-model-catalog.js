// Worklab's seam onto Pi's built-in model catalog.
//
// agent-runtime owns the Pi dependency: the façade returns cloned
// snapshots rather than handing out pi-ai's mutable registry, and it keeps the
// exact 0.83.0 pin inside the runtime instead of forcing it on consumers.
// This module stays because callers rely on getPiModel() throwing on an
// unknown model, whereas the façade returns undefined.
import { getPiBuiltinModel, listPiBuiltinModels } from "@mono-agent/agent-runtime/ai";

export function getPiModels(provider) {
  return listPiBuiltinModels(provider);
}

export function getPiModel(provider, modelId) {
  const model = getPiBuiltinModel(provider, modelId);
  if (!model) throw new Error(`unknown Pi model: ${provider}:${modelId}`);
  return model;
}
