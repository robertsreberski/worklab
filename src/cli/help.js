const COMMON_OPTIONS = [
  ["--port PORT", "Set the HTTP port, also written into the managed service."],
  ["--host HOST", "Set the bind host. Keep 127.0.0.1 for normal local use."],
  ["--data-dir DIR", "Use a different Worklab data directory."],
  ["--workspace DIR", "Use a different default workspace for task runs."],
  ["--drain-timeout-ms MS", "Maximum worker drain window for service stop/restart."],
  ["-h, --help", "Show help."],
];

const COMMANDS = [
  {
    name: "start",
    usage: "worklab start [options]",
    summary: "Build the UI, install/update the user service, and start Worklab.",
    options: [
      ["--no-build", "Skip rebuilding src/ui/dist before starting."],
    ],
    common: true,
  },
  {
    name: "restart",
    usage: "worklab restart [options]",
    summary: "Build the UI, install/update the user service, and restart Worklab.",
    options: [
      ["--no-build", "Skip rebuilding src/ui/dist before restarting."],
    ],
    common: true,
  },
  {
    name: "stop",
    usage: "worklab stop [options]",
    summary: "Stop the managed service, falling back to the coordinator pid file.",
    common: true,
  },
  {
    name: "status",
    usage: "worklab status [options]",
    summary: "Show service, coordinator, health, and runtime configuration status.",
    common: true,
  },
  {
    name: "serve",
    usage: "worklab serve [options]",
    summary: "Run the API/static server in the foreground.",
    common: true,
  },
  {
    name: "doctor",
    usage: "worklab doctor [options]",
    summary: "Check local runtime health, service wiring, database integrity, MCP config, and embeddings.",
    subcommands: [
      ["worklab doctor performance [options]", "Measure startup-sensitive endpoints and database/blob size risks."],
    ],
    common: true,
  },
  {
    name: "doctor performance",
    usage: "worklab doctor performance [options]",
    summary: "Measure endpoint timings, response sizes, database size, and largest event logs.",
    options: [
      ["--json", "Print machine-readable JSON."],
    ],
    common: true,
  },
  {
    name: "onboard",
    usage: "worklab onboard [options]",
    summary: "Run the first-install setup wizard for tools, local providers, embeddings, service, and doctor checks.",
    description: [
      "Interactive by default. Use --yes for recommended defaults: Ollama,",
      "Worklab skills for available Codex and Claude Code CLIs, nomic-embed-text",
      "embeddings, service start, hosted auth guidance, and final doctor checks.",
    ],
    options: [
      ["--yes", "Accept recommended defaults and non-destructive setup actions."],
      ["--dry-run", "Print planned setup actions without writing provider/settings/skill changes."],
      ["--local-provider NAME", "Local provider: ask, ollama, lmstudio, or none. Default: ask."],
      ["--embedding MODE", "Embedding setup: ask, yes, local, openai, or no. Default: ask."],
      ["--no-start", "Configure Worklab without starting the managed service."],
    ],
    common: true,
  },
  {
    name: "auth",
    usage: "worklab auth pi openai-codex [options]",
    summary: "Create Pi OAuth auth for OpenAI Codex and store it in pi-auth.json.",
    description: [
      "Runs the pi-ai OAuth login flow and writes credentials to the active",
      "Worklab data directory as pi-auth.json. Environment keys still take",
      "precedence when OPENAI_CODEX_API_KEY or CODEX_API_KEY is set.",
    ],
    options: [
      ["--dry-run", "Print the auth target path without starting OAuth or writing files."],
    ],
    common: true,
  },
  {
    name: "backup",
    usage: "worklab backup [options]",
    summary: "Create a credential-scrubbed tar.gz backup of the active data directory.",
    description: [
      "Known credentials, keys, MCP config, webhook IDs, browser push subscriptions,",
      "runtime logs, and process files are omitted. Reconfigure those integrations",
      "after restoring. Task, comment, knowledge, attachment, and run content remains",
      "and may be sensitive; this is not general content redaction.",
      "The output directory and archive use private 0700 and 0600 permissions.",
      "The output directory must be outside the active Worklab data directory.",
    ],
    options: [
      ["--out DIR", "Write the backup archive to DIR. Defaults to ~/worklab-backups."],
    ],
    common: true,
  },
  {
    name: "compact-logs",
    usage: "worklab compact-logs [options]",
    summary: "Dry-run or apply safe compaction of old, large agent event logs.",
    description: [
      "Default mode is a read-only dry run. Applying compaction keeps the newest events",
      "for eligible logs, strips full tool input/output from SQLite, and records the",
      "original event count and byte size. Full tool I/O remains in raw run JSONL files.",
      "Pinned run-result KB entries, running runs, recent logs, and already compacted logs",
      "are skipped unless --recompact is passed.",
    ],
    options: [
      ["--apply", "Write compaction changes. Refuses to run while the coordinator is active."],
      ["--strategy NAME", "Compaction strategy: slim-db (default) or tail."],
      ["--recompact", "Allow already compacted logs to be compacted with the current strategy."],
      ["--min-age-days DAYS", "Only consider logs at least DAYS old. Default: 7."],
      ["--min-bytes BYTES", "Only consider event blobs at least BYTES bytes. Default: 524288."],
      ["--keep-events COUNT", "Keep the newest COUNT events in each compacted log. Default: 200."],
      ["--max-event-bytes BYTES", "Maximum compacted SQLite bytes per event. Default: 16384."],
      ["--max-log-bytes BYTES", "Optional maximum compacted SQLite bytes per run log. Default: 0 (disabled)."],
      ["--vacuum", "Run SQLite VACUUM after applying compaction."],
      ["--json", "Print machine-readable JSON."],
    ],
    common: true,
  },
  {
    name: "update",
    usage: "worklab update [options]",
    summary: "Check npm for a newer Worklab version or apply a supported global npm update.",
    options: [
      ["--json", "Print machine-readable JSON."],
      ["--refresh", "Bypass the cached npm registry check."],
      ["--apply", "Install the requested npm version globally and restart the managed service."],
      ["--version VERSION", "Target version for --apply. Must match npm latest."],
    ],
    common: true,
  },
  {
    name: "mcp",
    usage: "worklab mcp [options]",
    summary: "Run the full-access Worklab admin MCP bridge over stdio.",
    common: true,
  },
  {
    name: "install-skill",
    usage: "worklab install-skill --target codex|claude|all [options]",
    summary: "Install the Worklab host skill into Codex or Claude Code.",
    description: [
      "Default mode creates a symlink from the selected tool's skills directory",
      "to this checkout's canonical skills/worklab directory. Use --copy when",
      "a physical copy is required instead of a live link.",
    ],
    options: [
      ["--target TARGET", "Destination tool: codex, claude, or all."],
      ["--copy", "Install a physical copy instead of the default symlink."],
      ["--force", "Replace an existing worklab skill directory or symlink."],
      ["--dry-run", "Print the planned action without writing files."],
    ],
  },
  {
    name: "install-service",
    usage: "worklab install-service [options]",
    summary: "Render or install the launchd/systemd user service definition.",
    options: [
      ["--dry-run", "Print the service definition instead of writing it."],
    ],
    common: true,
  },
  {
    name: "uninstall-service",
    usage: "worklab uninstall-service [options]",
    summary: "Remove the launchd/systemd user service definition.",
    options: [
      ["--dry-run", "Print the removal commands instead of executing them."],
    ],
  },
];

const COMMAND_BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

function helpFlag(value) {
  return value === "--help" || value === "-h";
}

function optionBlock(title, rows = []) {
  if (!rows.length) return "";
  const width = Math.max(...rows.map(([flag]) => flag.length));
  return [
    `${title}:`,
    ...rows.map(([flag, description]) => `  ${flag.padEnd(width)}  ${description}`),
  ].join("\n");
}

function commandRows() {
  const visible = COMMANDS.filter((command) => !command.name.includes(" "));
  const width = Math.max(...visible.map((command) => command.name.length));
  return visible.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`).join("\n");
}

export function commandNames() {
  return COMMANDS
    .filter((command) => !command.name.includes(" "))
    .map((command) => command.name);
}

export function hasCommandHelp(topic) {
  return COMMAND_BY_NAME.has(topic);
}

export function formatGeneralHelp() {
  return [
    "Worklab",
    "",
    "Local agent orchestration app for running, inspecting, and maintaining Worklab.",
    "",
    "Usage: worklab <command> [options]",
    "",
    "Commands:",
    commandRows(),
    "",
    "Nested commands:",
    "  doctor performance  Measure endpoint timings, payload sizes, and database/blob growth.",
    "",
    optionBlock("Common options", COMMON_OPTIONS),
    "",
    "Use `worklab help <command>` or `worklab <command> --help` for command-specific options.",
  ].join("\n");
}

export function formatCommandHelp(topic) {
  const command = COMMAND_BY_NAME.get(topic);
  if (!command) {
    return [`Unknown command: ${topic}`, "", formatGeneralHelp()].join("\n");
  }
  const blocks = [
    `Usage: ${command.usage}`,
    "",
    command.summary,
  ];
  if (command.description?.length) {
    blocks.push("", command.description.join("\n"));
  }
  if (command.subcommands?.length) {
    blocks.push("", optionBlock("Subcommands", command.subcommands));
  }
  if (command.options?.length) {
    blocks.push("", optionBlock("Options", command.options));
  }
  if (command.common) {
    blocks.push("", optionBlock("Common options", COMMON_OPTIONS));
  }
  return blocks.join("\n");
}

export function resolveHelpTopic(command, args = []) {
  if (command === "help") {
    const topicParts = args.filter((arg) => !helpFlag(arg));
    if (topicParts.length === 0) return null;
    const nested = topicParts.slice(0, 2).join(" ");
    if (hasCommandHelp(nested)) return nested;
    return topicParts[0];
  }

  if (helpFlag(command) || (!command && args.some(helpFlag))) return null;
  if (!args.some(helpFlag)) return undefined;

  const topicParts = [command, ...args.filter((arg) => !helpFlag(arg))].filter(Boolean);
  const nested = topicParts.slice(0, 2).join(" ");
  if (hasCommandHelp(nested)) return nested;
  return topicParts[0] || null;
}
