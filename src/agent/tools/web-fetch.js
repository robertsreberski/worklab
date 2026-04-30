import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "./shared/constants.js";
import { capChars } from "./shared/output-truncation.js";

export async function webFetchToolImpl({ url, headers = {}, max_output_chars }) {
  const maxChars = Number(max_output_chars) || DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  try { new URL(url); } catch { return "Error: Invalid URL"; }
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Worklab/0.1", ...headers }, signal: AbortSignal.timeout(15000) });
    const text = await resp.text();
    if (!resp.ok) return `HTTP ${resp.status}: ${text.slice(0, 500)}`;
    return capChars(text, { label: "WebFetch", maxChars });
  } catch (err) {
    return `Error fetching URL: ${err.message}`;
  }
}
