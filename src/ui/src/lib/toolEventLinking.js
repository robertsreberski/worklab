const FILE_EDIT_PREFIX = "file_edit:";
const FILE_MUTATION_TOOLS = new Set(["Edit", "Write"]);

export function sourceToolIdForFileEditId(id) {
  const value = String(id || "");
  if (!value.startsWith(FILE_EDIT_PREFIX) || value.length <= FILE_EDIT_PREFIX.length) return null;
  return value.slice(FILE_EDIT_PREFIX.length);
}

export function isMutationToolName(name) {
  return FILE_MUTATION_TOOLS.has(String(name || ""));
}

export function toolResultPayload(toolResult) {
  if (!toolResult || typeof toolResult !== "object") return null;
  return toolResult.output ?? toolResult.content ?? toolResult.result ?? null;
}

export function hasFileEditChangesPayload(payload) {
  return Boolean(
    payload
      && typeof payload === "object"
      && Array.isArray(payload.changes)
      && payload.changes.length > 0,
  );
}

export function hasFileEditChangeDetails(toolUse, toolResult) {
  return hasFileEditChangesPayload(toolUse?.input) || hasFileEditChangesPayload(toolResultPayload(toolResult));
}

export function fileEditDisplayName(toolUse) {
  return toolUse?.display_name || toolUse?.displayName || toolUse?.name || "";
}
