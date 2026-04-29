// §4.16 ToolCallBlock — expandable tool invocation view.
// Uses the unified typography from §4.15/§4.17 (INPUT / OUTPUT are mono --text-sm
// on --surface-sunken with --sp-3 padding and --radius-sm; matches Markdown pre).

import { useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { StructuredValue } from "./StructuredValue.jsx";
import { ShimmerBar } from "./primitives/ShimmerBar.jsx";
import { fileEditChangeLabel, fileEditKindLabel, fileEditLineDelta, shortFilePath } from "../lib/fileEditDisplay.js";
import { rawJsonText } from "../lib/structuredValue.js";

function inputAsText(input) {
  if (input == null) return "";
  return rawJsonText(input);
}

function fileEditChanges(value) {
  const payload = value && typeof value === "object" ? value : {};
  return Array.isArray(payload.changes) ? payload.changes : [];
}

export function fileEditSummary(value) {
  const changes = fileEditChanges(value);
  if (!changes.length) return "";
  const summary = value?.summary || {};
  const added = Number(summary.added_lines);
  const removed = Number(summary.removed_lines);
  if (changes.length > 1) {
    const delta = Number.isFinite(added) || Number.isFinite(removed)
      ? ` (+${Number.isFinite(added) ? added : 0} -${Number.isFinite(removed) ? removed : 0})`
      : "";
    return `${changes.length} files${delta}`;
  }
  const change = changes[0];
  return fileEditChangeLabel(change);
}

function FileEditResult({ value }) {
  const changes = fileEditChanges(value);
  const summary = fileEditSummary(value);
  const status = value?.status || "";
  return (
    <div class="file-edit-result">
      <div class="file-edit-head">
        <strong>File edit</strong>
        {status && <span class="file-edit-status">{status}</span>}
        {summary && <span class="file-edit-summary">{summary}</span>}
      </div>
      {changes.length ? (
        <ul class="file-edit-list">
          {changes.map((change, index) => {
            const delta = fileEditLineDelta(change?.line_stats);
            return (
              <li key={`${change?.path || "change"}-${index}`}>
                <span class="file-edit-kind">{fileEditKindLabel(change?.kind)}</span>
                <code title={change?.path || ""}>{shortFilePath(change?.path || "")}</code>
                {delta && <span class="file-edit-delta">{delta}</span>}
                {change?.line_stats?.unavailable_reason && (
                  <span class="file-edit-muted">{change.line_stats.unavailable_reason}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div class="tool-call-missing-note">No file details were captured.</div>
      )}
    </div>
  );
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

function isGenericStructuredOutputAck(value) {
  return String(value || "").trim() === "Structured output received.";
}

export function ToolCallBlock({ toolUse, toolResult, structuredOutput, messageStatus }) {
  const [expanded, setExpanded] = useState(false);
  const pending = !toolResult && !structuredOutput && messageStatus === "streaming";
  const missing = !toolResult && !structuredOutput && messageStatus !== "streaming";
  const isError = Boolean(toolResult?.is_error || toolResult?.error);
  const truncated = Boolean(toolResult?.truncated);
  const rawOutput = toolResult?.output ?? toolResult?.content ?? toolResult?.result;
  const outputText = rawOutput == null ? "" : rawJsonText(rawOutput);
  const inputText = inputAsText(toolUse?.input);
  const outputIsEmpty = outputText.trim().length === 0;
  const isFileEdit = toolUse?.name === "file_edit";
  const isStructuredOutput = toolUse?.name === "StructuredOutput";
  const hasStructuredAck = isGenericStructuredOutputAck(rawOutput);
  const showStructuredResult = isStructuredOutput && !isError && (structuredOutput || hasStructuredAck);
  const structuredValue = structuredOutput?.worklab_result
    || structuredOutput?.value
    || structuredOutput?.structured_output
    || toolUse?.input;
  const fileSummary = isFileEdit ? fileEditSummary(rawOutput ?? toolUse?.input) : "";
  const glyphName = showStructuredResult ? "check-circle" : isFileEdit ? "file-text" : "terminal";
  const structuredSummary = String(structuredValue?.summary || structuredValue?.final_text || "").trim();
  const label = showStructuredResult
    ? `Worklab result${structuredSummary ? ` · ${structuredSummary}` : ""}`
    : isFileEdit && fileSummary
      ? `file_edit · ${fileSummary}`
      : toolUse?.name || "unknown";

  let statusIcon;
  let stateLabel;
  if (pending) {
    statusIcon = (
      <span class="tool-call-status-running tool-call-spinner" aria-hidden="true">
        <Icon name="refresh-cw" size={13} strokeWidth={2} />
      </span>
    );
    stateLabel = "running";
  } else if (isError) {
    statusIcon = <Icon name="alert-triangle" size={13} class="tool-call-status-error" />;
    stateLabel = "error";
  } else if (missing) {
    statusIcon = <Icon name="circle" size={13} class="tool-call-status-missing" />;
    stateLabel = "no result captured";
  } else if (showStructuredResult) {
    statusIcon = <Icon name="check" size={13} class="tool-call-status-ok" />;
    stateLabel = "structured output";
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
    pending ? "tool-call-running" : "",
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
          <Icon name={glyphName} size={13} class="tool-call-glyph chat-tool-glyph" />
          <span class="tool-call-label chat-tool-label">{label}</span>
        </span>
        <Icon name="chevron-down" size={14} class={`tool-call-chevron chat-tool-chevron ${expanded ? "open" : ""}`} />
      </button>
      {pending && <ShimmerBar height={2} class="tool-call-progress" />}
      {expanded && (
        <div class="tool-call-body chat-tool-body">
          <div class="tool-call-section chat-tool-section">
            <div class="tool-call-section-header chat-tool-section-header">
              <span>{showStructuredResult ? "STRUCTURED OUTPUT" : "INPUT"}</span>
              {inputText && <CopyButton text={inputText} label={showStructuredResult ? "Copy structured output" : "Copy tool input"} />}
            </div>
            {inputText ? (
              <StructuredValue value={showStructuredResult ? structuredValue : toolUse?.input} hideRaw class="tool-call-structured" />
            ) : (
              <pre class="tool-call-pre">(empty)</pre>
            )}
          </div>
          {toolResult && !(showStructuredResult && hasStructuredAck) && (
            <div class="tool-call-section chat-tool-section">
              <div class="tool-call-section-header chat-tool-section-header">
                <span>{isError ? "ERROR" : "OUTPUT"}</span>
                {!outputIsEmpty && <CopyButton text={outputText} label="Copy tool output" />}
              </div>
              {truncated && (
                <div class="tool-call-truncated-note">
                  Output truncated for display. Full raw log is available from the run.
                </div>
              )}
              {outputIsEmpty && !isError ? (
                <div class="tool-call-missing-note">Tool returned empty output.</div>
              ) : isFileEdit && rawOutput && !isError ? (
                <FileEditResult value={rawOutput} />
              ) : (
                <StructuredValue value={rawOutput} hideRaw class={`tool-call-structured ${isError ? "tool-call-error" : ""}`} />
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
