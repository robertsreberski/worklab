// src/__tests__/helpers/fake-worker.js
// Run as a child process; emits events per FAKE_WORKER_SCRIPT env var
// Script format: JSON { "events": [{ "type": "...", ...payload, "delayMs": 10 }], "exitCode": 0, "exitAfterMs": 100 }

const script = JSON.parse(process.env.FAKE_WORKER_SCRIPT || '{"events":[],"exitCode":0}');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let aborted = false;
process.on("SIGTERM", () => { aborted = true; });

async function run() {
  for (const e of script.events) {
    if (aborted) { emit({ type: "cancelled" }); process.exit(130); }
    const { delayMs = 0, ...payload } = e;
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    emit(payload);
  }
  if (script.exitAfterMs) await new Promise(r => setTimeout(r, script.exitAfterMs));
  process.exit(aborted ? 130 : (script.exitCode || 0));
}

run();
