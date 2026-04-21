#!/usr/bin/env node
import { start } from "./start.js";
import { stop } from "./stop.js";
import { status } from "./status.js";
import { doctor } from "./doctor.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);

const commands = { start, stop, status, doctor };

if (!cmd || !(cmd in commands)) {
  console.error("usage: worklab <start|stop|status|doctor>");
  process.exit(1);
}

commands[cmd](args).catch((err) => {
  console.error(err);
  process.exit(1);
});
