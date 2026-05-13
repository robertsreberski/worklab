// Minimal consumer of @worklab-ai/agent-runtime.
//
// Demonstrates the createRuntime → runtime.run() flow with Claude SDK and a
// single Bash tool call. Run with:
//
//   ANTHROPIC_API_KEY=sk-ant-... npm --workspace=echo-agent start
//
// Without the API key the script prints what it would do and exits without
// hitting the network.

import { createRuntime, runtimeCapabilities } from "@worklab-ai/agent-runtime";

async function main() {
  const runtime = createRuntime({
    workspace: process.cwd(),
    repoRoot: process.cwd(),
  });

  console.log("Available bridges:");
  for (const sdk of ["claude", "pi", "codex"]) {
    const caps = runtimeCapabilities(sdk);
    console.log(`  - ${sdk.padEnd(8)} runtime=${caps.runtime}`);
  }
  console.log();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY is not set — skipping live run.");
    console.log("To exercise the runtime end-to-end, set the key and re-run.");
    return;
  }

  const result = await runtime.run("You are a helpful assistant.", {
    model: { sdk: "claude", model: "claude-sonnet-4-6" },
    executionMode: "sdk",
    messages: [
      { role: "user", content: "Run `echo hello from the runtime` and tell me what you saw." },
    ],
    cwd: process.cwd(),
    allowedTools: ["Bash"],
    maxTurns: 4,
    permissionMode: "bypassPermissions",
    onEvent: (event) => {
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) process.stdout.write(block.text);
        }
      }
    },
  });

  console.log();
  console.log("---");
  console.log(`Final text:    ${result.text}`);
  console.log(`Turns:         ${result.numTurns}`);
  console.log(`Duration:      ${result.durationMs} ms`);
  console.log(`Cost (USD):    ${result.usage?.cost_usd ?? "n/a"}`);
  if (result.error) console.log(`Error:         ${result.error}`);
}

main().catch((err) => {
  console.error("echo-agent failed:", err);
  process.exit(1);
});
