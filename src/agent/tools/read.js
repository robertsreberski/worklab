import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_MAX_READ_CHARS,
  DEFAULT_READ_LINES,
  MAX_READ_LINES,
} from "./shared/constants.js";
import { boundedInt, rememberRead, trimLine } from "./shared/dedup.js";
import { capChars } from "./shared/output-truncation.js";
import { isPathAllowed, resolveToolPath } from "./shared/path-resolver.js";

export async function readToolImpl({ file_path, offset = 0, start_line, limit, max_output_chars, workdir }) {
  const target = resolveToolPath(file_path, workdir);
  if (!isPathAllowed(target, workdir)) return `Error: Path not allowed: ${file_path}`;
  if (!existsSync(target)) return `Error: File not found: ${file_path}`;
  const content = readFileSync(target, "utf8");
  let lines = content.split("\n");
  const total = lines.length;
  const explicitStartLine = Number(start_line);
  const start = Number.isInteger(explicitStartLine) && explicitStartLine > 0
    ? explicitStartLine - 1
    : Math.max(0, Number(offset) || 0);
  const requested = limit == null
    ? DEFAULT_READ_LINES
    : boundedInt(limit, DEFAULT_READ_LINES, { min: 1, max: MAX_READ_LINES });
  const requestedExceeded = limit != null && Number(limit) > MAX_READ_LINES;
  lines = lines.slice(start, start + requested);
  const repeated = rememberRead(target, start, requested);
  const numbered = lines.map((line, i) => `${start + i + 1}\t${trimLine(line)}`).join("\n");
  const nextLine = start + lines.length + 1;
  const notes = [];
  if (requestedExceeded) notes.push(`Requested limit was capped at ${MAX_READ_LINES} lines.`);
  if (nextLine <= total) notes.push(`Next unread line: ${nextLine}. Continue with offset=${nextLine - 1} or start_line=${nextLine}.`);
  if (repeated) notes.push("This exact file range was already read in this process; use a narrower or later range if you need new context.");
  return capChars(`${numbered}${notes.length ? `\n\n${notes.join("\n")}` : ""}`, {
    label: "Read",
    maxChars: Number(max_output_chars) || DEFAULT_MAX_READ_CHARS,
    hint: "Use Read with offset/start_line and limit for the specific range you need.",
  });
}
