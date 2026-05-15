// Provider fallback router.
//
// Wraps `createRuntime` with an ordered chain of model references. If a run
// fails with a retryable provider error (per `retryableProviderFailureInfo`),
// the router retries the same logical run with the next chain entry,
// prepending the transcript-tail snapshot of the previous attempt to the
// system prompt so the next provider can continue rather than restart.
//
// Inspired by zeroclaw's RouterProvider hint-resolution pattern, but goes
// further: zeroclaw's router resolves a hint to one provider and never
// falls back automatically. This router does, using the failure-kind
// taxonomy and capability matrix we already maintain.
//
// API:
//   createRouterRuntime({ host, chain })
//     returns { run(systemPrompt, options) }
//
//   chain entries:
//     { model: ModelRef, executionMode?: "sdk" | "cli", requires?: Capabilities }
//   shorthand: a bare ModelRef is also accepted (no requirements).
//
// Result:
//   The success run's result, with `failoverHistory` appended describing every
//   prior attempt: [{ model, failureKind, requestId, retryableSubkind }].
//   If every entry in the chain fails, returns the last result with
//   `failureKind: "provider_unavailable_exhausted"`.

import { createRuntime } from "../../runtime.js";
import { retryableProviderFailureInfo } from "../failure.js";
import { runtimeCapabilities } from "./capabilities.js";
import { buildTranscriptTailSnapshot, renderResumeSnapshot } from "../../agent/transcript.js";

export function createRouterRuntime({ host = {}, chain = [] } = {}) {
  const entries = normaliseChain(chain);
  if (entries.length === 0) {
    throw new Error("createRouterRuntime requires a non-empty chain");
  }
  const inner = createRuntime(host);

  return {
    async run(systemPrompt, options = {}) {
      const failoverHistory = [];
      let lastResult = null;
      let resumeSnapshot = null;

      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (!entrySatisfiesRequirements(entry, options)) {
          failoverHistory.push({
            model: entry.model,
            failureKind: "skipped_capability_mismatch",
            requirements: entry.requires,
          });
          continue;
        }

        const callOptions = {
          ...options,
          model: entry.model,
          executionMode: entry.executionMode || options.executionMode,
        };
        if (resumeSnapshot) {
          callOptions.diagnosticsSeed = {
            ...(callOptions.diagnosticsSeed || {}),
            resume_snapshot: resumeSnapshot,
          };
          // Also prepend the rendered snapshot to the system prompt so SDK
          // backends that don't read diagnosticsSeed still continue from the
          // previous attempt.
          const rendered = renderResumeSnapshot(resumeSnapshot);
          if (rendered) {
            callOptions.systemPromptPrefix = rendered;
            systemPrompt = `${rendered}\n\n${systemPrompt}`;
          }
        }

        if (failoverHistory.length > 0) {
          emit(callOptions, {
            type: "provider_failover_started",
            from: failoverHistory[failoverHistory.length - 1]?.model,
            to: entry.model,
            attemptIndex: i,
          });
        }

        let result;
        try {
          result = await inner.run(systemPrompt, callOptions);
        } catch (err) {
          // The inner runtime usually surfaces errors as structured result
          // fields, but a bridge can still throw synchronously (e.g. spawn
          // failures). Convert to a result-like shape so the chain logic
          // is uniform.
          result = {
            text: null,
            error: err?.message || String(err),
            failureKind: "provider_unavailable",
            events: [],
            cancelled: false,
            usage: {},
          };
        }

        const retryability = retryableProviderFailureInfo({
          errorText: result.error || "",
          stderrTail: result.stderrTail || "",
          failureKind: result.failureKind,
        });

        const successful = !result.error && !result.failureKind && !result.cancelled;
        if (successful) {
          if (failoverHistory.length > 0) {
            emit(callOptions, {
              type: "provider_failover_completed",
              attemptIndex: i,
              model: entry.model,
            });
          }
          return { ...result, failoverHistory };
        }

        failoverHistory.push({
          model: entry.model,
          failureKind: result.failureKind || null,
          requestId: retryability.requestId,
          retryableSubkind: retryability.subkind,
        });
        lastResult = result;

        // Bail early on non-retryable failures (auth, billing, cancellation,
        // invalid_result). Only retryable provider errors trigger fallback.
        const shouldFallback = retryability.retryable && !result.cancelled;
        if (!shouldFallback) break;

        // Build a transcript-tail snapshot from this run's events so the
        // next provider can continue. If the run produced no usable events,
        // skip the snapshot (the next attempt starts fresh).
        const snapshot = buildTranscriptTailSnapshot(result.events);
        if (snapshot) resumeSnapshot = snapshot;
      }

      const exhaustedResult = lastResult || {
        text: null,
        events: [],
        error: "router chain exhausted with no executions",
        failureKind: "provider_unavailable_exhausted",
        cancelled: false,
        usage: {},
      };
      return {
        ...exhaustedResult,
        failureKind: "provider_unavailable_exhausted",
        failoverHistory,
      };
    },
    chain: () => entries.slice(),
  };
}

function normaliseChain(chain) {
  if (!Array.isArray(chain)) return [];
  return chain
    .map((entry) => {
      if (!entry) return null;
      if (entry.sdk && entry.model) {
        // ModelRef shorthand: { sdk, model, ... }
        return { model: entry, executionMode: null, requires: null };
      }
      if (entry.model) {
        return {
          model: entry.model,
          executionMode: typeof entry.executionMode === "string" ? entry.executionMode : null,
          requires: entry.requires && typeof entry.requires === "object" ? entry.requires : null,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function entrySatisfiesRequirements(entry, options) {
  const requires = entry.requires;
  if (!requires) return true;
  let caps;
  try {
    caps = runtimeCapabilities(entry.model);
  } catch {
    return false;
  }
  for (const [key, expected] of Object.entries(requires)) {
    if (caps[key] !== expected) return false;
  }
  // Honour request-time outputSchema → require structured_output unless
  // already specified.
  if (options.outputSchema && requires.structured_output !== false && caps.structured_output === false) {
    return false;
  }
  return true;
}

function emit(callOptions, event) {
  try { callOptions.onEvent?.(event); } catch { /* swallow */ }
}
