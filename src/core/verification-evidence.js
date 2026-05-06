// intelligence-ramp Phase 4: deterministic cross-check that the reviewer's
// claimed verification commands actually appear in the tool log. Catches the
// "rubber-stamp with fabricated evidence" failure mode that the soft prompt
// can't prevent on its own.
import { getAgentLogEvents } from "./db/queries/agent-logs.js";
import { adjudicateVerificationEvidenceRow } from "./verification-adjudicator.js";

function safeParse(jsonText, fallback) {
  if (!jsonText) return fallback;
  try { return JSON.parse(jsonText); } catch { return fallback; }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`"'\\]/g, "")
    .replace(/[^a-z0-9:/._?=&%-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrls(value) {
  const matches = String(value || "").match(/https?:\/\/[^\s'"`<>)\]]+/gi) || [];
  return matches
    .map((url) => url.replace(/[.,;:!?]+$/, ""))
    .filter(Boolean);
}

function normalizeUrl(value) {
  const raw = String(value || "").trim().replace(/[.,;:!?]+$/, "");
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const path = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}${url.search}${url.hash}`.toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

function flattenStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) flattenStrings(item, out);
  }
  return out;
}

function firstStringByKey(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

function signalHaystack(signal) {
  return normalizeText([
    signal.name,
    signal.command,
    signal.url,
    signal.serialized,
    ...(signal.urls || []),
  ].filter(Boolean).join(" "));
}

function commandSegments(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const parts = text
    .split(/\s*(?:&&|\|\||;)\s*/g)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [];
}

// Walk a single event blob and yield every tool-call's name + a flattened
// string of its arguments / command for matching.
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
      const command = typeof args === "string" ? args : firstStringByKey(args, ["command", "cmd", "script"]);
      const url = typeof args === "string" ? "" : firstStringByKey(args, ["url", "uri", "href"]);
      const textValues = flattenStrings(args);
      yield {
        name,
        serialized,
        command,
        url,
        urls: [...new Set([...extractUrls(serialized), ...extractUrls(textValues.join(" "))].map(normalizeUrl))],
      };
    }
  }
}

export function collectToolSignals(db, runIds) {
  const signals = [];
  for (const runId of runIds.filter(Boolean)) {
    const row = getAgentLogEvents(db, runId);
    const events = safeParse(row?.events, []);
    let index = 0;
    for (const sig of iterToolCallSignals(events)) {
      signals.push({
        id: `${runId}:${index}`,
        run_id: runId,
        index,
        ...sig,
      });
      index += 1;
    }
  }
  return signals;
}

function singleSignalMatch(claim, signals) {
  const normalizedClaim = normalizeText(claim);
  if (!normalizedClaim) return null;
  const claimUrls = extractUrls(claim).map(normalizeUrl);
  if (claimUrls.length) {
    for (const sig of signals) {
      const signalUrls = new Set([...(sig.urls || []), normalizeUrl(sig.url)].filter(Boolean));
      if (claimUrls.some((url) => signalUrls.has(url))) {
        return { signal: sig, reason: "Evidence URL matched a logged tool-call URL." };
      }
    }
  }
  for (const sig of signals) {
    const haystack = signalHaystack(sig);
    if (haystack && haystack.includes(normalizedClaim)) {
      return { signal: sig, reason: "Evidence command_or_url matched logged tool-call arguments." };
    }
  }
  return null;
}

function evidenceMatch(evidence, signals) {
  const claim = String(evidence.command_or_url || "").trim();
  if (!claim) {
    return { matched: false, matched_tool_call: null, reason: "Missing command_or_url." };
  }
  const direct = singleSignalMatch(claim, signals);
  if (direct) {
    return {
      matched: true,
      match_source: "deterministic",
      matched_tool_call: direct.signal.id,
      reason: direct.reason,
      confidence: 1,
    };
  }
  const segments = commandSegments(claim);
  if (segments.length > 1) {
    const matches = segments.map((segment) => singleSignalMatch(segment, signals));
    if (matches.every(Boolean)) {
      const ids = [...new Set(matches.map((match) => match.signal.id))];
      return {
        matched: true,
        match_source: "deterministic",
        matched_tool_call: `multiple: ${ids.join(", ")}`,
        matched_tool_calls: ids,
        reason: "Every grouped command segment matched a logged tool call.",
        confidence: 1,
      };
    }
  }
  return { matched: false, matched_tool_call: null, reason: "No matching logged tool call." };
}

function checkableEvidence(evidence) {
  return evidence
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row && row.kind && row.kind !== "n_a");
}

function rowDetail({ row, index }, match) {
  return {
    evidence_index: index,
    kind: row.kind,
    command_or_url: row.command_or_url || "",
    exit_code_or_status: row.exit_code_or_status || "",
    snippet: row.snippet || "",
    match_source: match.matched ? match.match_source : null,
    matched_tool_call: match.matched ? match.matched_tool_call : null,
    ...(match.matched_tool_calls ? { matched_tool_calls: match.matched_tool_calls } : {}),
    reason: match.reason || "",
    confidence: Number.isFinite(match.confidence) ? match.confidence : 0,
  };
}

function resultFromRows(rows, { toolCallCount = 0, adjudicator = null } = {}) {
  const matchedRows = rows.filter((row) => row.match_source);
  const unmatchedRows = rows.filter((row) => !row.match_source);
  return {
    totalChecked: rows.length,
    matchedCount: matchedRows.length,
    unmatchedCount: unmatchedRows.length,
    matchedRows,
    unmatchedRows,
    rows,
    toolCallCount,
    ...(adjudicator ? { adjudicator } : {}),
  };
}

function crossCheckRowsFromSignals(evidence, signals) {
  const checkable = checkableEvidence(evidence);
  if (checkable.length === 0) {
    return { totalChecked: 0, matchedCount: 0, unmatchedCount: 0 };
  }
  const rows = checkable.map((item) => rowDetail(item, evidenceMatch(item.row, signals)));
  return resultFromRows(rows, { toolCallCount: signals.length });
}

// Return { totalChecked, matchedCount, unmatchedCount }.
// Rows with kind="n_a" are skipped (they document why no verification is needed).
// Rows with no command_or_url contribute as unmatched (a reviewer claiming
// `kind: "test"` without naming a command is no better than no evidence at all).
export function crossCheckVerificationEvidence(db, { reviewRunId, parentRunId, evidence } = {}) {
  if (!db || !Array.isArray(evidence) || evidence.length === 0) {
    return { totalChecked: 0, matchedCount: 0, unmatchedCount: 0 };
  }
  const signals = collectToolSignals(db, [reviewRunId, parentRunId]);
  return crossCheckRowsFromSignals(evidence, signals);
}

export async function crossCheckVerificationEvidenceWithAdjudicator(
  db,
  { reviewRunId, parentRunId, evidence, adjudicator = {}, fetchImpl = globalThis.fetch, logger = null } = {},
) {
  if (!db || !Array.isArray(evidence) || evidence.length === 0) {
    return { totalChecked: 0, matchedCount: 0, unmatchedCount: 0 };
  }
  const signals = collectToolSignals(db, [reviewRunId, parentRunId]);
  const base = crossCheckRowsFromSignals(evidence, signals);
  if (!base.unmatchedRows?.length || adjudicator?.mode !== "ollama") return base;

  const signalIds = new Set(signals.map((signal) => signal.id));
  const rows = base.rows.map((row) => ({ ...row }));
  for (const unmatched of base.unmatchedRows) {
    const decision = await adjudicateVerificationEvidenceRow({
      row: unmatched,
      signals,
      model: adjudicator.model,
      baseUrl: adjudicator.baseUrl,
      timeoutMs: adjudicator.timeoutMs,
      fetchImpl,
    });
    const row = rows.find((candidate) => candidate.evidence_index === unmatched.evidence_index);
    if (!row) continue;
    if (decision?.decision === "match" && signalIds.has(decision.matched_tool_call_id)) {
      row.match_source = "ollama";
      row.matched_tool_call = decision.matched_tool_call_id;
      row.reason = decision.reason || "Adjudicator matched this row to a logged tool call.";
      row.confidence = decision.confidence;
    } else {
      const label = decision?.decision || "no_match";
      row.reason = `Adjudicator ${label}: ${decision?.reason || "No matching logged tool call."}`;
      row.confidence = Number.isFinite(decision?.confidence) ? decision.confidence : 0;
    }
  }
  logger?.debug?.({
    reviewRunId,
    parentRunId,
    matchedCount: rows.filter((row) => row.match_source).length,
    totalChecked: rows.length,
  }, "verification evidence adjudicated");
  return resultFromRows(rows, {
    toolCallCount: signals.length,
    adjudicator: {
      mode: "ollama",
      model: adjudicator.model || null,
    },
  });
}
