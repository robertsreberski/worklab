export const ACP_PRIVATE_VALUE_LIMITS = Object.freeze({
  maxValues: 10_000,
  maxDepth: 10,
  maxNodes: 20_000,
  maxChars: 4 * 1024 * 1024,
});

/**
 * Scan one private-value payload against the shared coordinator/worker budget.
 * Tokens are strings for stable accounting while values retain their original
 * scalar types so coordinator-side event redaction can replace numbers and
 * booleans without coercing public output.
 */
export function scanAcpPrivateValues(value, {
  knownTokens = new Set(),
  knownChars = 0,
} = {}) {
  const values = new Set();
  const tokens = new Set();
  const state = { nodes: 0, chars: 0 };
  const baseChars = Number.isFinite(knownChars) && knownChars >= 0 ? knownChars : 0;

  function collect(entry, depth = 0) {
    if (depth > ACP_PRIVATE_VALUE_LIMITS.maxDepth) return false;
    state.nodes += 1;
    if (state.nodes > ACP_PRIVATE_VALUE_LIMITS.maxNodes) return false;
    if (entry == null) return true;
    if (["string", "number", "boolean"].includes(typeof entry)) {
      const token = String(entry);
      if (!token) return true;
      values.add(entry);
      if (knownTokens.has(token) || tokens.has(token)) return true;
      if (knownTokens.size + tokens.size >= ACP_PRIVATE_VALUE_LIMITS.maxValues
        || baseChars + state.chars + token.length > ACP_PRIVATE_VALUE_LIMITS.maxChars) {
        return false;
      }
      tokens.add(token);
      state.chars += token.length;
      return true;
    }
    if (Array.isArray(entry)) {
      return entry.every((item) => collect(item, depth + 1));
    }
    if (typeof entry !== "object") return true;
    return Object.values(entry).every((item) => collect(item, depth + 1));
  }

  let ok = false;
  try { ok = collect(value); } catch { /* proxies and hostile accessors fail closed */ }
  return {
    ok,
    values,
    tokens,
    chars: state.chars,
    nodes: state.nodes,
  };
}
