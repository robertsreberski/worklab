// Custom-provider queries used by the API edge.

export function countModelsForProvider(db, providerId) {
  return (
    db
      .prepare("SELECT COUNT(*) AS model_count FROM custom_models WHERE provider_id = ?")
      .get(providerId)?.model_count || 0
  );
}
