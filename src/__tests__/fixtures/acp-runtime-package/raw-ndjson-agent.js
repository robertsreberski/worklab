import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logFile = process.env.WORKLAB_ACP_CONTRACT_LOG;
const rawSessionId = process.env.WORKLAB_ACP_CONTRACT_RAW_SESSION_ID;
const rawCursor = process.env.WORKLAB_ACP_CONTRACT_RAW_CURSOR;

if (!logFile || !rawSessionId || !rawCursor) {
  throw new Error("ACP runtime package fixture requires its private test environment");
}

function record(value) {
  appendFileSync(logFile, `${JSON.stringify(value)}\n`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function reject(id, method) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unsupported fixture method: ${method}` },
  })}\n`);
}

record({ type: "fixture_started" });

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  record({ type: "fixture_received", method: message.method, params: message.params });

  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "raw-ndjson-fixture", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: {
            resume: {},
            list: {},
            delete: {},
          },
        },
        authMethods: [],
      });
      break;
    case "session/new":
      respond(message.id, { sessionId: rawSessionId });
      break;
    case "session/resume":
      respond(message.id, {});
      break;
    case "session/prompt":
      respond(message.id, { stopReason: "end_turn" });
      break;
    case "session/list":
      respond(message.id, {
        sessions: [{
          sessionId: rawSessionId,
          cwd: `/tmp/${rawSessionId}`,
          title: `Fixture ${rawSessionId}`,
          _meta: {
            copiedSessionId: rawSessionId,
            copiedCursor: rawCursor,
          },
        }],
        nextCursor: rawCursor,
      });
      break;
    case "session/delete":
      respond(message.id, {});
      break;
    default:
      reject(message.id, message.method);
  }
});
