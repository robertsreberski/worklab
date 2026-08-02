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
// `Agent` is the exact Pi built-in name and the event name emitted by current
// Claude Code. Keep `Task` as well: Claude Code accepts both names for the same
// native surface, and agent-runtime's native-profile compatibility path still
// appends `Task`. Omitting either makes at least one supported route silently
// lose delegation when Worklab sends its explicit named allowlist.
// The remaining native CLI names are the existing curated Worklab policy; keep
// them explicit rather than replacing the list with a wildcard.
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
  "Agent",
  "Task",
  "Skill",
  "SlashCommand",
  "NotebookEdit",
  "BashOutput",
  "KillShell",
];
