export const DEFAULT_VERIFICATION_ADJUDICATOR_MODEL = "gpt-oss-safeguard:20b";
export const DEFAULT_VERIFICATION_ADJUDICATOR_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_VERIFICATION_ADJUDICATOR_TIMEOUT_MS = 30000;

const MIN_MATCH_CONFIDENCE = 0.7;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["match", "no_match", "ambiguous"] },
    matched_tool_call_id: { type: "string" },
    reason: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["decision", "matched_tool_call_id", "reason", "confidence"],
};

function trimText(value, max = 1200) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function rootUrl(baseUrl) {
  return String(baseUrl || DEFAULT_VERIFICATION_ADJUDICATOR_BASE_URL).replace(/\/+$/, "");
}

function parseJsonObject(text) {
  if (text && typeof text === "object" && !Array.isArray(text)) return text;
  const raw = String(text || "").trim();
  if (!raw) throw new Error("empty adjudicator response");
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("adjudicator response was not JSON");
    return JSON.parse(match[0]);
  }
}

function responseContent(payload) {
  if (payload?.message?.content !== undefined) return payload.message.content;
  if (payload?.response !== undefined) return payload.response;
  return payload;
}

function candidateForPrompt(signal) {
  return {
    id: signal.id,
    run_id: signal.run_id,
    tool_name: signal.name,
    command: signal.command || null,
    url: signal.url || null,
    arguments_excerpt: trimText(signal.serialized, 1000),
  };
}

function tokens(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9_./:-]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function signalText(signal) {
  return [signal.name, signal.command, signal.url, signal.serialized].filter(Boolean).join(" ");
}

function candidateScore(row, signal) {
  const claim = `${row?.command_or_url || ""} ${row?.snippet || ""}`;
  const claimTokens = tokens(claim);
  if (!claimTokens.size) return 0;
  const sigText = signalText(signal).toLowerCase();
  let score = 0;
  for (const token of claimTokens) {
    if (sigText.includes(token)) score += 1;
  }
  return score;
}

function selectCandidates(row, signals, limit = 120) {
  const list = Array.isArray(signals) ? signals : [];
  if (list.length <= limit) return list;
  return list
    .map((signal, index) => ({ signal, index, score: candidateScore(row, signal) }))
    .sort((left, right) => (right.score - left.score) || (left.index - right.index))
    .slice(0, limit)
    .map((item) => item.signal);
}

function buildMessages({ row, signals }) {
  return [
    {
      role: "system",
      content: [
        "You are a local verification-evidence adjudicator.",
        "Decide whether one reviewer verification_evidence row is supported by one actual logged tool call.",
        "Return JSON only. Do not invent commands, URLs, tool calls, or ids.",
        "Use match only when the evidence describes a provided tool call, allowing harmless prose, quoting, path expansion, grouped shell wording, or URL/manual-check wording.",
        "Use no_match or ambiguous when the evidence is unsupported, too vague, or only plausibly related.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        policy: {
          match_requires_actual_tool_call_id: true,
          confidence_threshold: MIN_MATCH_CONFIDENCE,
          valid_decisions: ["match", "no_match", "ambiguous"],
        },
        evidence_row: {
          evidence_index: row.evidence_index,
          kind: row.kind || null,
          command_or_url: row.command_or_url || "",
          exit_code_or_status: row.exit_code_or_status || "",
          snippet: trimText(row.snippet || "", 700),
          reason: trimText(row.reason || "", 400),
        },
        tool_call_candidates: signals.map(candidateForPrompt),
      }),
    },
  ];
}

function normalizeDecision(value, signalsById) {
  const parsed = parseJsonObject(value);
  const decision = String(parsed.decision || "").trim();
  const reason = trimText(parsed.reason || "No adjudicator reason provided.", 500);
  const confidence = Number(parsed.confidence);
  const matchedToolCallId = parsed.matched_tool_call_id == null
    ? null
    : String(parsed.matched_tool_call_id || "").trim();

  if (!["match", "no_match", "ambiguous"].includes(decision)) {
    throw new Error("adjudicator returned an invalid decision");
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("adjudicator returned an invalid confidence");
  }
  if (decision !== "match") {
    return { decision, matched_tool_call_id: null, reason, confidence };
  }
  if (!matchedToolCallId || !signalsById.has(matchedToolCallId)) {
    return {
      decision: "no_match",
      matched_tool_call_id: null,
      reason: `Adjudicator referenced an unknown tool call id: ${matchedToolCallId || "(missing)"}.`,
      confidence: 0,
    };
  }
  if (confidence < MIN_MATCH_CONFIDENCE) {
    return {
      decision: "ambiguous",
      matched_tool_call_id: null,
      reason: `Adjudicator confidence ${confidence.toFixed(2)} is below ${MIN_MATCH_CONFIDENCE}. ${reason}`,
      confidence,
    };
  }
  return { decision, matched_tool_call_id: matchedToolCallId, reason, confidence };
}

export async function adjudicateVerificationEvidenceRow({
  row,
  signals,
  model = DEFAULT_VERIFICATION_ADJUDICATOR_MODEL,
  baseUrl = DEFAULT_VERIFICATION_ADJUDICATOR_BASE_URL,
  timeoutMs = DEFAULT_VERIFICATION_ADJUDICATOR_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const candidates = selectCandidates(row, signals);
  const signalsById = new Map(candidates.map((signal) => [signal.id, signal]));
  if (!row) {
    return { decision: "no_match", matched_tool_call_id: null, reason: "No evidence row provided.", confidence: 0 };
  }
  if (!candidates.length) {
    return { decision: "no_match", matched_tool_call_id: null, reason: "No logged tool calls are available.", confidence: 0 };
  }
  if (typeof fetchImpl !== "function") {
    return { decision: "no_match", matched_tool_call_id: null, reason: "Adjudicator fetch is unavailable.", confidence: 0 };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs) || DEFAULT_VERIFICATION_ADJUDICATOR_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${rootUrl(baseUrl)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: model || DEFAULT_VERIFICATION_ADJUDICATOR_MODEL,
        stream: false,
        format: RESPONSE_SCHEMA,
        options: { temperature: 0 },
        messages: buildMessages({ row, signals: candidates }),
      }),
    });
    if (!response?.ok) {
      return {
        decision: "no_match",
        matched_tool_call_id: null,
        reason: `Adjudicator request failed with status ${response?.status || 0}.`,
        confidence: 0,
      };
    }
    const payload = await response.json();
    return normalizeDecision(responseContent(payload), signalsById);
  } catch (err) {
    return {
      decision: "no_match",
      matched_tool_call_id: null,
      reason: `Adjudicator failed: ${err?.name === "AbortError" ? "request timed out" : err?.message || String(err)}`,
      confidence: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}
