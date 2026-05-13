import { describe, expect, it } from "vitest";
import { compactRecoveryRunSummary } from "../../coordinator/watcher/failure-classifier.js";

describe("compactRecoveryRunSummary", () => {
  it("surfaces nested provider diagnostics for retryable fetch failures", () => {
    const summary = compactRecoveryRunSummary({
      runId: "run-1",
      reason: "provider_retryable",
      providerInfo: { subkind: "terminated", requestId: "req-1" },
      res: {
        error: "fetch failed",
        diagnostics: {
          error_details: {
            pi_transport: "sse",
            pi_error_code: "terminated",
            last_tool_name: "todo_write",
            turn_count: 19,
            tool_results_seen: 45,
            partial_progress: true,
            context_risk: "high",
          },
        },
      },
    });

    expect(summary).toContain("provider connection drop after 19 turn(s) (terminated)");
    expect(summary).toContain("Provider request ID: req-1");
    expect(summary).toContain("Provider diagnostics:");
    expect(summary).toContain("transport=sse");
    expect(summary).toContain("last_tool=todo_write");
    expect(summary).toContain("turns=19");
    expect(summary).toContain("tool_results=45");
    expect(summary).toContain("partial_progress=true");
    expect(summary).toContain("context=high");
  });
});
