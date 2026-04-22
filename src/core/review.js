/**
 * Parse a reviewer's verdict from the final text of a review.
 *
 * Scans for the first non-blank line. If it matches the pattern
 * `/^\s*VERDICT:\s*(APPROVE|REJECT)\b/`, extracts the verdict.
 * Otherwise returns { verdict: null, notes: "" }.
 *
 * @param {*} finalText - The reviewer's text to parse
 * @returns {{ verdict: "APPROVE" | "REJECT" | null, notes: string }}
 *   - For APPROVE: notes is always ""
 *   - For REJECT: notes is everything after the verdict line, trimmed (outer whitespace only)
 *   - For null: notes is ""
 */
export function parseVerdict(finalText) {
  // Handle non-string or nullish input
  if (typeof finalText !== "string" || finalText == null) {
    return { verdict: null, notes: "" };
  }

  // Split by newlines to find the first non-blank line
  const lines = finalText.split("\n");
  let verdictLine = null;
  let verdictIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      verdictLine = lines[i];
      verdictIndex = i;
      break;
    }
  }

  // If no non-blank line found, return null
  if (verdictLine === null) {
    return { verdict: null, notes: "" };
  }

  // Test against the verdict pattern: must have exact uppercase APPROVE or REJECT
  // with word boundary after (so APPROVED, REJECTS, etc. don't match)
  const verdictMatch = verdictLine.match(/^\s*VERDICT:\s*(APPROVE|REJECT)\b/);

  if (!verdictMatch) {
    return { verdict: null, notes: "" };
  }

  const verdict = verdictMatch[1];

  // APPROVE: notes is always empty
  if (verdict === "APPROVE") {
    return { verdict: "APPROVE", notes: "" };
  }

  // REJECT: notes are everything after this line, with outer whitespace trimmed
  const remainingLines = lines.slice(verdictIndex + 1);
  const notesRaw = remainingLines.join("\n");
  const notes = notesRaw.trim();

  return { verdict: "REJECT", notes };
}
