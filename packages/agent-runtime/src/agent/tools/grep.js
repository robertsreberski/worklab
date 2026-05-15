import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
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
  resolveRgPath,
  ripgrepMissingMessage,
} from "./shared/ripgrep.js";

const execFileAsync = promisify(execFile);

export async function grepToolImpl({
  pattern,
  path,
  glob,
  type,
  output_mode = "files_with_matches",
  context,
  case_insensitive,
  multiline,
  head_limit,
  offset = 0,
  max_matches,
  max_output_chars,
  workdir,
}) {
  const target = resolveToolPath(path || workspaceRoot(workdir), workdir);
  if (!isPathAllowed(target, workdir)) return `Error: Path not allowed: ${target}`;
  const stat = safeStat(target);
  if (!stat) return `Error: Path not found: ${target}`;
  const cwd = stat.isDirectory() ? target : dirname(target);
  const searchTarget = stat.isDirectory() ? "." : basename(target);
  const mode = ["content", "count", "files_with_matches"].includes(output_mode) ? output_mode : "files_with_matches";
  const args = ["--no-config", "--hidden", "--color=never"];
  if (mode === "files_with_matches") args.push("--files-with-matches");
  else if (mode === "count") args.push("--count-matches");
  else args.push("--line-number");
  if (case_insensitive) args.push("-i");
  if (mode === "content" && context) args.push(`-C${boundedInt(context, 0, { min: 0, max: 20 })}`);
  if (multiline) args.push("-U", "--multiline-dotall");
  if (glob) args.push("--glob", glob);
  if (type) args.push("--type", type);
  args.push(...excludedGlobArgs(), "--", pattern, searchTarget);
  const resultLimit = boundedInt(head_limit ?? max_matches, DEFAULT_MAX_SEARCH_LINES, { min: 1, max: 1000 });
  const rgPath = resolveRgPath();
  if (!rgPath) return ripgrepMissingMessage();
  try {
    const { stdout } = await execFileAsync(rgPath, args, { cwd, timeout: 15000, maxBuffer: SEARCH_MAX_BUFFER });
    const normalized = stdout.trim().split("\n").filter(Boolean).map((line) => line.replace(/^\.\//, ""));
    const formatted = capLines(normalized.join("\n"), {
      label: "Grep",
      noMatches: "No matches found.",
      maxLines: resultLimit,
      maxChars: Number(max_output_chars) || DEFAULT_MAX_SEARCH_CHARS,
      offset,
    });
    return formatted === "No matches found." ? formatted : `${formatted}\n\n${excludedPathSummary()}`;
  } catch (err) {
    if (err.code === 1) return "No matches found.";
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(err.message || "")) {
      return `${capLines(err.stdout || "", {
        label: "Grep",
        noMatches: "Grep result exceeded the output limit before any preview could be captured.",
        maxLines: resultLimit,
        maxChars: Number(max_output_chars) || DEFAULT_MAX_SEARCH_CHARS,
        offset,
      })}\n\n${excludedPathSummary()}`;
    }
    return `Error: ${err.message}`;
  }
}
