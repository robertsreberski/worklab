import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { shortHash } from "./context-cache.js";

// Lookup order matters: CLAUDE.md is the modern Claude Code convention,
// AGENTS.md is the codex-style fallback. We do NOT auto-merge — keeping them
// separate is a deliberate choice some projects make (different audiences
// for the two files), so silently concatenating would surprise users.
const REPOSITORY_INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];
export const REPOSITORY_INSTRUCTIONS_MAX_CHARS = 64_000;
const REPOSITORY_INSTRUCTIONS_PROMPT_SECTION = "Repository instructions";

function truncationMarker(rawLength, capChars) {
  const totalKb = Math.round(rawLength / 1024);
  const shownKb = Math.round(capChars / 1024);
  return `\n\n[!!! TRUNCATED — repository instructions are ${totalKb} KB, only the first ${shownKb} KB are shown above. Read the source file directly for the rest if it matters.]`;
}

export function loadRepositoryInstructions(workdir) {
  if (!workdir) return null;
  for (const filename of REPOSITORY_INSTRUCTION_FILES) {
    const path = join(workdir, filename);
    try {
      if (!existsSync(path)) continue;
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const raw = readFileSync(path, "utf8");
      const truncated = raw.length > REPOSITORY_INSTRUCTIONS_MAX_CHARS;
      const content = truncated
        ? `${raw.slice(0, REPOSITORY_INSTRUCTIONS_MAX_CHARS)}${truncationMarker(raw.length, REPOSITORY_INSTRUCTIONS_MAX_CHARS)}`
        : raw;
      return {
        filename,
        path,
        content,
        hash: shortHash(raw),
        size: Buffer.byteLength(raw, "utf8"),
        truncated,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function findRepositoryGitRoot(workdir) {
  if (!workdir) return null;
  let current = resolve(workdir);
  while (current) {
    const gitPath = join(current, ".git");
    try {
      const stat = statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) return current;
    } catch {
      // Continue walking to the parent.
    }
    const parent = dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

export function repositoryInstructionsPromptMetadata(instructions) {
  if (!instructions) return null;
  return {
    recognized: true,
    filename: instructions.filename,
    path: instructions.path,
    hash: instructions.hash,
    size: instructions.size,
    truncated: !!instructions.truncated,
    injected_into_prompts: true,
    prompt_section: REPOSITORY_INSTRUCTIONS_PROMPT_SECTION,
  };
}
