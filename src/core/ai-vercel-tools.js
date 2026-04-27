import { tool } from "ai";
import { z } from "zod";
import {
  bashToolImpl,
  editToolImpl,
  globToolImpl,
  grepToolImpl,
  readToolImpl,
  webFetchToolImpl,
  webSearchToolImpl,
  writeToolImpl,
} from "./ai-tool-helpers.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function stripFrontmatter(content) {
  const m = content.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? content.slice(m[0].length).trim() : content.trim();
}

function readSkillTool(skillNames = [], dataDir) {
  const safe = skillNames.filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name));
  if (!safe.length || !dataDir) return null;
  return tool({
    description: "Load the full instructions for a named Worklab skill.",
    inputSchema: z.object({ name: z.enum(safe) }),
    execute: async ({ name }) => {
      const path = resolve(dataDir, "skills", name, "SKILL.md");
      const root = resolve(dataDir, "skills");
      if (!path.startsWith(root + "/")) return `Error: invalid skill path: ${name}`;
      if (!existsSync(path)) return `Error: SKILL.md not found for ${name}`;
      return stripFrontmatter(readFileSync(path, "utf8")).slice(0, 12000);
    },
  });
}

export function getVercelTools({ allowedTools, skillNames = [], dataDir } = {}) {
  const all = {
    Read: tool({ description: "Read a local file with line numbers.", inputSchema: z.object({ file_path: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional() }), execute: readToolImpl }),
    Write: tool({ description: "Write content to a local file.", inputSchema: z.object({ file_path: z.string(), content: z.string() }), execute: writeToolImpl }),
    Edit: tool({ description: "Replace an exact string in a local file.", inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }), execute: editToolImpl }),
    Glob: tool({ description: "Find files matching a pattern.", inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }), execute: globToolImpl }),
    Grep: tool({ description: "Search file contents with grep.", inputSchema: z.object({ pattern: z.string(), path: z.string().optional(), glob: z.string().optional(), context: z.number().int().optional(), case_insensitive: z.boolean().optional() }), execute: grepToolImpl }),
    Bash: tool({ description: "Execute a shell command in the Worklab workspace.", inputSchema: z.object({ command: z.string(), timeout: z.number().int().optional() }), execute: bashToolImpl }),
    WebFetch: tool({ description: "Fetch a URL and return text.", inputSchema: z.object({ url: z.string(), headers: z.record(z.string(), z.string()).optional() }), execute: webFetchToolImpl }),
    WebSearch: tool({ description: "Search the web and return result summaries.", inputSchema: z.object({ query: z.string(), limit: z.number().int().optional() }), execute: webSearchToolImpl }),
  };
  const names = Array.isArray(allowedTools) ? allowedTools : Object.keys(all);
  const out = Object.fromEntries(names.filter((name) => all[name]).map((name) => [name, all[name]]));
  const skillTool = readSkillTool(skillNames, dataDir);
  if (skillTool) out.read_skill = skillTool;
  return out;
}
