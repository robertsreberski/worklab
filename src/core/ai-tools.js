import { tool } from "@openai/agents";
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

function makeTool(name, description, properties, required, execute) {
  return tool({ name, description, parameters: { type: "object", properties, required }, strict: false, execute });
}

function stripFrontmatter(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? content.slice(m[0].length).trim() : content.trim();
}

function readSkillTool(skillNames = [], dataDir) {
  const safe = skillNames.filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name));
  if (!safe.length || !dataDir) return null;
  return makeTool(
    "read_skill",
    "Load the full instructions for a named Worklab skill.",
    { name: { type: "string", enum: safe } },
    ["name"],
    async ({ name }) => {
      const path = resolve(dataDir, "skills", name, "SKILL.md");
      const root = resolve(dataDir, "skills");
      if (!path.startsWith(root + "/")) return `Error: invalid skill path: ${name}`;
      if (!existsSync(path)) return `Error: SKILL.md not found for ${name}`;
      return stripFrontmatter(readFileSync(path, "utf8")).slice(0, 12000);
    },
  );
}

export function getOpenAITools(allowedTools = [], { skillNames = [], dataDir } = {}) {
  const all = {
    Read: makeTool("Read", "Read a local file with line numbers.", {
      file_path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" },
    }, ["file_path"], readToolImpl),
    Write: makeTool("Write", "Write content to a local file.", {
      file_path: { type: "string" }, content: { type: "string" },
    }, ["file_path", "content"], writeToolImpl),
    Edit: makeTool("Edit", "Replace an exact string in a local file.", {
      file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" },
    }, ["file_path", "old_string", "new_string"], editToolImpl),
    Glob: makeTool("Glob", "Find files matching a pattern.", {
      pattern: { type: "string" }, path: { type: "string" },
    }, ["pattern"], globToolImpl),
    Grep: makeTool("Grep", "Search file contents with grep.", {
      pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, context: { type: "integer" }, case_insensitive: { type: "boolean" },
    }, ["pattern"], grepToolImpl),
    Bash: makeTool("Bash", "Execute a shell command in the Worklab workspace.", {
      command: { type: "string" }, timeout: { type: "integer" },
    }, ["command"], bashToolImpl),
    WebFetch: makeTool("WebFetch", "Fetch a URL and return text.", {
      url: { type: "string" }, headers: { type: "object" },
    }, ["url"], webFetchToolImpl),
    WebSearch: makeTool("WebSearch", "Search the web and return result summaries.", {
      query: { type: "string" }, limit: { type: "integer" },
    }, ["query"], webSearchToolImpl),
  };
  const names = allowedTools?.length ? allowedTools : Object.keys(all);
  const tools = names.map((name) => all[name]).filter(Boolean);
  const skillTool = readSkillTool(skillNames, dataDir);
  if (skillTool) tools.push(skillTool);
  return tools;
}
