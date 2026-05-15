import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_MAX_SEARCH_CHARS,
  DEFAULT_MAX_SEARCH_LINES,
  SEARCH_MAX_BUFFER,
} from "./shared/constants.js";
import { boundedInt, safeStat } from "./shared/dedup.js";
import {
  isPathAllowed,
  resolveToolPath,
  workspaceRoot,
} from "./shared/path-resolver.js";
import {
  capLines,
  excludedGlobArgs,
  excludedPathSummary,
  formatSearchLines,
  normalizeGlobPattern,
  resolveRgPath,
  ripgrepMissingMessage,
} from "./shared/ripgrep.js";

const execFileAsync = promisify(execFile);

export async function globToolImpl({ pattern, path, limit, offset = 0, max_matches, max_output_chars, workdir }) {
  const cwd = resolveToolPath(path || workspaceRoot(workdir), workdir);
  if (!isPathAllowed(cwd, workdir)) return `Error: Path not allowed: ${cwd}`;
  const stat = safeStat(cwd);
  if (!stat?.isDirectory()) return `Error: Glob path is not a directory: ${cwd}`;
  const resultLimit = boundedInt(limit ?? max_matches, DEFAULT_MAX_SEARCH_LINES, { min: 1, max: 1000 });
  const args = [
    "--files",
    "--hidden",
    "--color=never",
    "--glob",
    normalizeGlobPattern(pattern),
    ...excludedGlobArgs(),
  ];
  const rgPath = resolveRgPath();
  if (!rgPath) return ripgrepMissingMessage();
  try {
    const { stdout } = await execFileAsync(rgPath, args, { cwd, timeout: 15000, maxBuffer: SEARCH_MAX_BUFFER });
    const lines = stdout.trim().split("\n").filter(Boolean).sort((a, b) => {
      const aStat = safeStat(resolve(cwd, a));
      const bStat = safeStat(resolve(cwd, b));
      return (bStat?.mtimeMs || 0) - (aStat?.mtimeMs || 0) || a.localeCompare(b);
    });
    const result = formatSearchLines(lines, {
      label: "Glob",
      noMatches: "No files found matching pattern.",
      maxLines: resultLimit,
      maxChars: Number(max_output_chars) || DEFAULT_MAX_SEARCH_CHARS,
      offset,
    });
    return result === "No files found matching pattern." ? result : `${result}\n\n${excludedPathSummary()}`;
  } catch (err) {
    if (err.code === 1) return "No files found matching pattern.";
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(err.message || "")) {
      return `${capLines(err.stdout || "", {
        label: "Glob",
        noMatches: "Glob result exceeded the output limit before any preview could be captured.",
        maxLines: resultLimit,
        maxChars: Number(max_output_chars) || DEFAULT_MAX_SEARCH_CHARS,
        offset,
      })}\n\n${excludedPathSummary()}`;
    }
    return `Error: ${err.message}`;
  }
}
