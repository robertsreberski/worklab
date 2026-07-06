# echo-agent

Minimal example consumer of `@mono-agent/agent-runtime`. It imports the package, prints the available provider runtimes, and (when `ANTHROPIC_API_KEY` is set) runs a single Claude SDK turn that calls the `Bash` built-in tool to echo a message and reports back the result.

## Run

From the repo root:

```bash
# Print the available bridges; no network call.
npm --workspace=echo-agent start

# Run end-to-end against Claude SDK.
ANTHROPIC_API_KEY=sk-ant-... npm --workspace=echo-agent start
```

## What it shows

- Importing the package via the npm dependency `"@mono-agent/agent-runtime": "0.4.1"`.
- The `createRuntime({ workspace, repoRoot })` setup pattern.
- A single-turn `runtime.run(systemPrompt, options)` call.
- Streaming assistant text via `onEvent`.
- Reading `result.text`, `result.numTurns`, `result.durationMs`, `result.usage.cost_usd`.

It deliberately does **not** demonstrate structured output, MCP servers, compaction, or live-input steering.
