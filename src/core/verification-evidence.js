// intelligence-ramp Phase 4: deterministic cross-check that the reviewer's
// claimed verification commands actually appear in the tool log. Catches the
// "rubber-stamp with fabricated evidence" failure mode that the soft prompt
// can't prevent on its own.
import { getAgentLogEvents } from "./db/queries/agent-logs.js";

function safeParse(jsonText, fallback) {
  if (!jsonText) return fallback;
  try { return JSON.parse(jsonText); } catch { return fallback; }
}

// Walk a single event blob and yield every tool-call's name + a flattened
// string of its arguments / command for substring matching.
function* iterToolCallSignals(events) {
  if (!Array.isArray(events)) return;
  for (const event of events) {
    const inner = event?.type === "sdk_event" && event.event ? event.event : event;
    const blocks = Array.isArray(inner?.message?.content)
      ? inner.message.content
      : Array.isArray(inner?.content) ? inner.content : [];
    for (const block of blocks) {
      if (block?.type !== "tool_use" && block?.type !== "toolCall") continue;
      const name = String(block.name || "").trim();
      const args = block.input ?? block.arguments ?? {};
      let serialized = "";
      try {
        serialized = typeof args === "string" ? args : JSON.stringify(args);
      } catch {
        serialized = String(args || "");
      }
      yield { name, serialized };
    }
  }
}

function collectToolSignals(db, runIds) {
  const signals = [];
  for (const runId of runIds.filter(Boolean)) {
    const row = getAgentLogEvents(db, runId);
    const events = safeParse(row?.events, []);
    for (const sig of iterToolCallSignals(events)) signals.push(sig);
  }
  return signals;
}

function evidenceMatchesAnySignal(evidence, signals) {
  const claim = String(evidence.command_or_url || "").trim();
  if (!claim) return false;
  const haystack = claim.toLowerCase();
  for (const sig of signals) {
    if (sig.serialized.toLowerCase().includes(haystack)) return true;
    // Loose match: "npm test" claim matches "Bash" tool with command starting with npm test.
    if (sig.name && haystack.includes(sig.name.toLowerCase())) return true;
  }
  return false;
}

// Return { totalChecked, matchedCount, unmatchedCount }.
// Rows with kind="n_a" are skipped (they document why no verification is needed).
// Rows with no command_or_url contribute as unmatched (a reviewer claiming
// `kind: "test"` without naming a command is no better than no evidence at all).
export function crossCheckVerificationEvidence(db, { reviewRunId, parentRunId, evidence } = {}) {
  if (!db || !Array.isArray(evidence) || evidence.length === 0) {
    return { totalChecked: 0, matchedCount: 0, unmatchedCount: 0 };
  }
  const checkable = evidence.filter((row) => row && row.kind && row.kind !== "n_a");
  if (checkable.length === 0) {
    return { totalChecked: 0, matchedCount: 0, unmatchedCount: 0 };
  }
  const signals = collectToolSignals(db, [reviewRunId, parentRunId]);
  let matched = 0;
  for (const row of checkable) {
    if (evidenceMatchesAnySignal(row, signals)) matched += 1;
  }
  return {
    totalChecked: checkable.length,
    matchedCount: matched,
    unmatchedCount: checkable.length - matched,
  };
}
