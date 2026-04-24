// §4.16 ToolCallBlock — expandable tool invocation view.
// Uses the unified typography from §4.15/§4.17 (INPUT / OUTPUT are mono --text-sm
// on --surface-sunken with --sp-3 padding and --radius-sm; matches Markdown pre).

import { useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";

function inputAsText(input) {
  if (input == null) return "";
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); } catch { /* best-effort */ }
}

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="tool-call-copy"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        writeClipboard(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
    </button>
  );
}

export function ToolCallBlock({ toolUse, toolResult, messageStatus }) {
  const [expanded, setExpanded] = useState(false);
  const pending = !toolResult && messageStatus === "streaming";
  const missing = !toolResult && messageStatus !== "streaming";
  const isError = Boolean(toolResult?.is_error || toolResult?.error);
  const rawOutput = toolResult?.output ?? toolResult?.content ?? toolResult?.result;
  const outputText = typeof rawOutput === "string" ? rawOutput : (rawOutput == null ? "" : JSON.stringify(rawOutput, null, 2));
  const inputText = inputAsText(toolUse?.input);
  const outputIsEmpty = outputText.trim().length === 0;

  let statusIcon;
  let stateLabel;
  if (pending) {
    statusIcon = <span class="tool-call-spinner" aria-hidden="true" />;
    stateLabel = "running";
  } else if (isError) {
    statusIcon = <Icon name="alert-triangle" size={13} class="tool-call-status-error" />;
    stateLabel = "error";
  } else if (missing) {
    statusIcon = <Icon name="circle" size={13} class="tool-call-status-missing" />;
    stateLabel = "no result captured";
  } else if (outputIsEmpty) {
    statusIcon = <Icon name="minus-circle" size={13} class="tool-call-status-empty" />;
    stateLabel = "empty output";
  } else {
    statusIcon = <Icon name="check" size={13} class="tool-call-status-ok" />;
    stateLabel = "ok";
  }

  const blockClass = [
    "tool-call",
    "chat-tool-block", // legacy alias
    missing ? "chat-tool-block-missing" : "",
    isError ? "chat-tool-block-error" : "",
    !missing && !isError && outputIsEmpty && !pending ? "chat-tool-block-empty" : "",
  ].filter(Boolean).join(" ");

  return (
    <div class={blockClass} title={stateLabel}>
      <button
        type="button"
        class="tool-call-header chat-tool-header"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span class="tool-call-name chat-tool-name">
          {statusIcon}
          <Icon name="terminal" size={13} class="tool-call-glyph chat-tool-glyph" />
          <span class="tool-call-label chat-tool-label">{toolUse?.name || "unknown"}</span>
        </span>
        <Icon name="chevron-down" size={14} class={`tool-call-chevron chat-tool-chevron ${expanded ? "open" : ""}`} />
      </button>
      {expanded && (
        <div class="tool-call-body chat-tool-body">
          <div class="tool-call-section chat-tool-section">
            <div class="tool-call-section-header chat-tool-section-header">
              <span>INPUT</span>
              {inputText && <CopyButton text={inputText} label="Copy tool input" />}
            </div>
            <pre class="tool-call-pre">{inputText || "(empty)"}</pre>
          </div>
          {toolResult && (
            <div class="tool-call-section chat-tool-section">
              <div class="tool-call-section-header chat-tool-section-header">
                <span>{isError ? "ERROR" : "OUTPUT"}</span>
                {!outputIsEmpty && <CopyButton text={outputText} label="Copy tool output" />}
              </div>
              {outputIsEmpty && !isError ? (
                <div class="tool-call-missing-note">Tool returned empty output.</div>
              ) : (
                <pre class={`tool-call-pre ${isError ? "tool-call-error" : ""}`}>{outputText}</pre>
              )}
            </div>
          )}
          {missing && (
            <div class="tool-call-section chat-tool-missing-note">
              No result was captured for this tool call.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
