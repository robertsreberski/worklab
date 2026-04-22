#!/usr/bin/env node
import { start } from "./start.js";
import { stop } from "./stop.js";
import { status } from "./status.js";
import { doctor } from "./doctor.js";
import { backup } from "./backup.js";
import { installService } from "./install-service.js";
import { uninstallService } from "./uninstall-service.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);

const commands = {
  start,
  stop,
  status,
  doctor,
  backup,
  "install-service": installService,
  "uninstall-service": uninstallService,
};

if (!cmd || !(cmd in commands)) {
  console.error("usage: worklab <start|stop|status|doctor|backup|install-service|uninstall-service>");
  process.exit(1);
}

commands[cmd](args).catch((err) => {
  console.error(err);
  process.exit(1);
});
