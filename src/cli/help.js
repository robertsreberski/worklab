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
    name: "backup",
    usage: "worklab backup [options]",
    summary: "Create a tar.gz backup of the active data directory.",
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
      "for eligible logs and records the original event count and byte size.",
      "Pinned run-result KB entries, running runs, recent logs, and already compacted logs are skipped.",
    ],
    options: [
      ["--apply", "Write compaction changes. Refuses to run while the coordinator is active."],
      ["--min-age-days DAYS", "Only consider logs at least DAYS old. Default: 7."],
      ["--min-bytes BYTES", "Only consider event blobs at least BYTES bytes. Default: 524288."],
      ["--keep-events COUNT", "Keep the newest COUNT events in each compacted log. Default: 200."],
      ["--vacuum", "Run SQLite VACUUM after applying compaction."],
      ["--json", "Print machine-readable JSON."],
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
