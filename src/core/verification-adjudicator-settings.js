export const DEFAULT_VERIFICATION_ADJUDICATOR_MODEL = "";
export const DEFAULT_VERIFICATION_ADJUDICATOR_TIMEOUT_MS = 30000;

function cleanPart(value, message) {
  if (!value || typeof value !== "string" || value.trim() !== value) throw new Error(message);
  return value;
}

export function parseVerificationAdjudicatorModelReference(value) {
  if (!value || typeof value !== "string") throw new Error("verification adjudicator model reference required");
  const text = value.trim();
  if (!text) throw new Error("verification adjudicator model reference required");
  const i = text.indexOf(":");
  if (i > 0) {
    const kind = text.slice(0, i);
    const rest = text.slice(i + 1);
    if (kind === "vercel" || kind === "provider") {
      const j = rest.indexOf(":");
      if (j <= 0 || j === rest.length - 1) {
        throw new Error("invalid verification adjudicator model reference; expected provider:<providerId>:<model>");
      }
      const providerId = cleanPart(rest.slice(0, j), "provider id required");
      const model = cleanPart(rest.slice(j + 1), "verification adjudicator model id required");
      return { kind: "provider", providerId, model, reference: `provider:${providerId}:${model}`, rawReference: text };
    }
  }
  return { kind: "legacy", model: text, reference: text };
}
