// The builtin tools Worklab grants a run, before per-agent allowlist filtering.
//
// This list is a ceiling, not a wish list: `run-input.js` filters a stored
// custom allowlist against it, and `tool-policy-projection.js` treats "every
// entry granted" as the signal to collapse the policy to `["*"]` for runtimes
// that cannot enforce a named list. Adding a name here therefore widens what an
// agent in `builtin_allowlist_mode: "all"` receives.
//
// Names the target runtime does not recognize are ignored rather than rejected
// (verified against Claude Code 2.1.220: `--tools Read,NotARealTool,Task`
// returns `Agent, Read` and `is_error: false`), so an entry a given backend
// lacks costs nothing on that backend.
//
// `Task` is the subagent tool. Claude Code accepts both `Task` and `Agent` in
// `--tools` and resolves either to the same tool, but every *event* it emits
// reports `name: "Agent"` — so match on `Agent` when rendering, and keep `Task`
// here because that is the name agent-runtime's own `withTaskTool` appends.
// Without it the CLI is invoked with a named `--tools` list that excludes the
// subagent tool, which silently disables on-disk `.claude/agents` discovery.
//
// `TodoWrite` is deliberately absent: Worklab owns run todos through
// `core/run-todos.js` and the agent MCP surface, and enabling the native tool
// would create a second, unwired todo list.
export const WORKLAB_BUILTIN_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Task",
  "Skill",
  "SlashCommand",
  "NotebookEdit",
  "BashOutput",
  "KillShell",
];
