import {
  assistantTextsFromEvents,
  sanitizeAgentText,
} from "./final-text.js";
import { looksLikePlanBody } from "./delegation-handler.js";

function planCandidateScore(body) {
  const text = String(body || "").trim();
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  if (looksLikePlanBody(text)) score += 20;
  const headingMatches = text.match(/^#{1,4}\s+(?:execplan|proposed plan|implementation plan|plan|summary|key changes|api\/interfaces\/types|test plan|verification|verification gates|assumptions|context|context & assumptions|step-by-step implementation|steps?|risks?|risks & recovery notes)\b.*$/gim) || [];
  score += headingMatches.length * 8;
  const boldHeadingMatches = text.match(/^\*\*(?:execplan|proposed plan|implementation plan|plan|summary|key changes|test plan|verification|assumptions|steps?|risks?)\b.*\*\*/gim) || [];
  score += boldHeadingMatches.length * 5;
  const numberedSteps = text.match(/^\s*\d+\.\s+\S/gm) || [];
  score += Math.min(numberedSteps.length, 8) * 2;
  if (/\b(execplan|implementation plan|test plan|verification gates|completion criteria|step-by-step implementation)\b/i.test(text)) score += 10;
  if (text.length >= 800) score += 8;
  else if (text.length >= 350) score += 4;
  if (/\b(message above|plan above|see above|mirrored in the structured|schema validator|re-emit|structured output)\b/i.test(lower)) score -= 12;
  return Math.max(0, score);
}

function bestPlanCandidate(candidates) {
  let best = null;
  candidates.forEach((candidate) => {
    const body = sanitizeAgentText(candidate);
    if (!body) return;
    const score = planCandidateScore(body);
    if (score < 24) return;
    if (!best || score > best.score || (score === best.score && body.length > best.body.length)) {
      best = { body, score };
    }
  });
  return best?.body || "";
}

function planBodyFromRun(result, finalText, events = []) {
  const structuredPlan = sanitizeAgentText(result?.details);
  const rawPlan = sanitizeAgentText(finalText);
  const assistantPlans = assistantTextsFromEvents(events).reverse().map((text) => sanitizeAgentText(text));
  const selectedPlan = bestPlanCandidate([structuredPlan, rawPlan, ...assistantPlans]);
  if (selectedPlan) return selectedPlan;
  for (const candidate of [structuredPlan, result?.summary, rawPlan]) {
    const body = sanitizeAgentText(candidate);
    if (body) return body;
  }
  return "";
}

export function planBodySideEffect(runId, agentName, result, finalText, events = []) {
  const body = planBodyFromRun(result, finalText, events);
  if (!body) return null;
  return {
    type: "set_plan_body",
    body,
    runId,
    updatedBy: agentName || "agent",
  };
}
