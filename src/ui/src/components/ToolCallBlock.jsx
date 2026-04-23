import { useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";

function inputAsText(input) {
  if (input == null) return "";
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard permissions are best-effort in local tooling UIs.
  }
}

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="chat-tool-copy"
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
    statusIcon = <span class="chat-tool-spinner" aria-hidden="true" />;
    stateLabel = "running";
  } else if (isError) {
    statusIcon = <Icon name="alert-triangle" size={13} class="chat-tool-status chat-tool-status-error" />;
    stateLabel = "error";
  } else if (missing) {
    statusIcon = <Icon name="circle" size={13} class="chat-tool-status chat-tool-status-missing" />;
    stateLabel = "no result captured";
  } else if (outputIsEmpty) {
    statusIcon = <Icon name="minus-circle" size={13} class="chat-tool-status chat-tool-status-empty" />;
    stateLabel = "empty output";
  } else {
    statusIcon = <Icon name="check" size={13} class="chat-tool-status chat-tool-status-ok" />;
    stateLabel = "ok";
  }

  const blockClass = [
    "chat-tool-block",
    missing ? "chat-tool-block-missing" : "",
    isError ? "chat-tool-block-error" : "",
    !missing && !isError && outputIsEmpty && !pending ? "chat-tool-block-empty" : "",
  ].filter(Boolean).join(" ");

  return (
    <div class={blockClass} title={stateLabel}>
      <button
        type="button"
        class="chat-tool-header"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span class="chat-tool-name">
          {statusIcon}
          <Icon name="terminal" size={13} class="chat-tool-glyph" />
          <span class="chat-tool-label">{toolUse?.name || "unknown"}</span>
        </span>
        <Icon name="chevron-down" size={14} class={`chat-tool-chevron ${expanded ? "open" : ""}`} />
      </button>
      {expanded && (
        <div class="chat-tool-body">
          <div class="chat-tool-section">
            <div class="chat-tool-section-header">
              <span class="text-label">INPUT</span>
              {inputText && <CopyButton text={inputText} label="Copy tool input" />}
            </div>
            <pre class="agentlog-coll-body">{inputText || "(empty)"}</pre>
          </div>
          {toolResult && (
            <div class="chat-tool-section">
              <div class="chat-tool-section-header">
                <span class="text-label">{isError ? "ERROR" : "OUTPUT"}</span>
                {!outputIsEmpty && <CopyButton text={outputText} label="Copy tool output" />}
              </div>
              {outputIsEmpty && !isError ? (
                <div class="chat-tool-missing-note">Tool returned empty output.</div>
              ) : (
                <pre class={`agentlog-coll-body ${isError ? "chat-tool-error" : ""}`}>{outputText}</pre>
              )}
            </div>
          )}
          {missing && (
            <div class="chat-tool-section chat-tool-missing-note">
              No result was captured for this tool call.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
