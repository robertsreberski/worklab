#!/usr/bin/env node
import { bootstrapWorklabEnv } from "../core/index.js";
import { applyConfigArgs } from "./args.js";
import {
  commandNames,
  formatCommandHelp,
  formatGeneralHelp,
  hasCommandHelp,
  resolveHelpTopic,
} from "./help.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);

const commands = {
  start: async (argv) => (await import("./start.js")).start(argv),
  serve: async (argv) => (await import("./start.js")).serve(argv),
  restart: async (argv) => (await import("./restart.js")).restart(argv),
  stop: async (argv) => (await import("./stop.js")).stop(argv),
  status: async (argv) => (await import("./status.js")).status(argv),
  doctor: async (argv) => (await import("./doctor.js")).doctor(argv),
  backup: async (argv) => (await import("./backup.js")).backup(argv),
  "compact-logs": async (argv) => (await import("./compact-logs.js")).compactLogsCli(argv),
  mcp: async (argv) => (await import("./mcp.js")).mcp(argv),
  "install-service": async (argv) => (await import("./install-service.js")).installService(argv),
  "uninstall-service": async (argv) => (await import("./uninstall-service.js")).uninstallService(argv),
};

const helpTopic = resolveHelpTopic(cmd, args);
if (helpTopic !== undefined) {
  if (helpTopic && !hasCommandHelp(helpTopic)) {
    console.error(formatCommandHelp(helpTopic));
    process.exit(1);
  }
  console.log(helpTopic ? formatCommandHelp(helpTopic) : formatGeneralHelp());
  process.exit(0);
}

if (!cmd || !(cmd in commands)) {
  const commandList = commandNames().join("|");
  console.error(`usage: worklab <${commandList}> [options]\n\nRun \`worklab --help\` for commands and \`worklab <command> --help\` for command options.`);
  process.exit(1);
}

try {
  applyConfigArgs(args);
  bootstrapWorklabEnv({ createDataDir: true });
} catch (err) {
  console.error(err);
  process.exit(1);
}

commands[cmd](args).catch((err) => {
  console.error(err);
  process.exit(1);
});
