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

function makeTool(name, description, properties, required, execute) {
  return tool({ name, description, parameters: { type: "object", properties, required }, strict: false, execute });
}

export function getOpenAITools(allowedTools = []) {
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
  return names.map((name) => all[name]).filter(Boolean);
}
