// src/__tests__/helpers/fake-worker.js
// Run as a child process; emits events per FAKE_WORKER_SCRIPT env var
// Script format: JSON {
//   "events": [{ "type": "...", ...payload, "delayMs": 10 }],
//   "exitCode": 0,
//   "exitAfterMs": 100,
//   "echoControls": false,
//   "drain": {
//     "emitDrained": true,         // emit a `drained` event on receipt
//     "emitCancelled": true,       // emit `{type:"cancelled", drained:true}` after `drained`
//     "exitCode": 0,               // exit code on drain
//     "exitAfterMs": 0             // delay between handling drain and exit
//   },
//   "ignoreDrain": false           // simulate a worker that doesn't drain in time
// }

const script = JSON.parse(process.env.FAKE_WORKER_SCRIPT || '{"events":[],"exitCode":0}');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let aborted = false;
let drainHandled = false;
process.on("SIGTERM", () => { aborted = true; });

const drainConfig = script.drain || null;

function handleDrainMessage(message) {
  if (script.ignoreDrain) {
    // Pretend we never received the drain — exercises the coordinator's
    // drain timeout fallback path.
    return;
  }
  if (drainHandled) return;
  drainHandled = true;
  const cfg = drainConfig || { emitDrained: true, emitCancelled: true, exitCode: 0, exitAfterMs: 5 };
  if (cfg.emitDrained !== false) {
    emit({ type: "drained", reason: message?.reason || "coordinator_shutdown", deadline_at: message?.deadline_at || null });
  }
  setTimeout(() => {
    if (cfg.emitCancelled !== false) {
      emit({ type: "cancelled", initiator: "coordinator_shutdown", drained: true });
    }
    process.exit(cfg.exitCode ?? 0);
  }, Math.max(0, Number(cfg.exitAfterMs) || 0));
}

if (script.echoControls || drainConfig || script.ignoreDrain) {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (script.echoControls) emit({ type: "control_seen", malformed: line });
        continue;
      }
      if (script.echoControls) emit({ type: "control_seen", message: parsed });
      if (parsed?.type === "worklab_drain") handleDrainMessage(parsed);
    }
  });
}

async function run() {
  for (const e of script.events) {
    if (aborted) { emit({ type: "cancelled" }); process.exit(130); }
    const { delayMs = 0, ...payload } = e;
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    emit(payload);
  }
  if (script.exitAfterMs) await new Promise(r => setTimeout(r, script.exitAfterMs));
  if (drainHandled) return; // drain handler will exit the process
  process.exit(aborted ? 130 : (script.exitCode || 0));
}

run();
