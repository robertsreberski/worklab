import { useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import {
  parseMaybeJson,
  rawJsonText,
  schemaPropertyRows,
  structuredErrorValue,
  structuredKind,
  structuredPreview,
} from "../lib/structuredValue.js";

async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); } catch { /* best-effort */ }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function Badge({ children, tone = "" }) {
  if (!children && children !== 0) return null;
  return <span class={`structured-badge ${tone}`.trim()}>{children}</span>;
}

function CopyRawButton({ raw }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="structured-copy"
      onClick={() => writeClipboard(raw).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })}
      aria-label="Copy raw value"
      title="Copy raw value"
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
    </button>
  );
}

function RawDisclosure({ raw }) {
  return (
    <details class="structured-raw">
      <summary>Raw</summary>
      <pre>{raw}</pre>
    </details>
  );
}

function Scalar({ value }) {
  if (value == null) return <span class="structured-null">null</span>;
  if (typeof value === "boolean") return <Badge tone={value ? "ok" : ""}>{String(value)}</Badge>;
  if (typeof value === "number") return <code>{value}</code>;
  return <span>{String(value)}</span>;
}

function KeyValueRows({ entries }) {
  const rows = entries.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!rows.length) return null;
  return (
    <dl class="structured-kv">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{isObject(value) || Array.isArray(value) ? <NestedValue value={value} /> : <Scalar value={value} />}</dd>
        </div>
      ))}
    </dl>
  );
}

function NestedValue({ value }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span class="structured-muted">empty</span>;
    if (value.every((item) => typeof item !== "object" || item == null)) {
      return <span>{value.map((item) => String(item)).join(", ")}</span>;
    }
    return (
      <details class="structured-nested">
        <summary>{value.length} item{value.length === 1 ? "" : "s"}</summary>
        <StructuredValue value={value} hideRaw />
      </details>
    );
  }
  if (isObject(value)) {
    return (
      <details class="structured-nested">
        <summary>{structuredPreview(value)}</summary>
        <StructuredValue value={value} hideRaw />
      </details>
    );
  }
  return <Scalar value={value} />;
}

function WorklabResult({ value }) {
  const result = value?.schema === "worklab.v2" ? value : value?.worklab_result;
  return (
    <>
      <div class="structured-header">
        <strong>Worklab result</strong>
        <div class="structured-badges">
          <Badge>{result.stage}</Badge>
          <Badge tone={result.decision === "approve" || result.decision === "advance" ? "ok" : result.decision === "reject" || result.decision === "block" ? "error" : ""}>{result.decision}</Badge>
        </div>
      </div>
      {result.summary && <p class="structured-summary">{result.summary}</p>}
      {result.details && result.details !== result.summary && <p class="structured-detail">{result.details}</p>}
      <KeyValueRows entries={[
        ["Artifacts", result.artifacts && Object.keys(result.artifacts).length ? result.artifacts : ""],
        ["Blocking", result.blocking_issues?.length ? result.blocking_issues : ""],
        ["Pending", result.pending_actions?.length ? result.pending_actions : ""],
        ["Subtasks", result.subtasks?.length ? result.subtasks : ""],
      ]} />
    </>
  );
}

function ErrorValue({ value }) {
  const err = structuredErrorValue(value) || (isObject(value?.error) ? value.error : value);
  return (
    <>
      <div class="structured-header">
        <strong>Error</strong>
        <div class="structured-badges">
          <Badge tone="error">{err.code}</Badge>
          <Badge>{err.param}</Badge>
          <Badge>{err.status || value.status}</Badge>
        </div>
      </div>
      <p class="structured-detail">{err.message || err.error || structuredPreview(err)}</p>
      <KeyValueRows entries={[
        ["Type", err.type],
        ["Status", err.status || value.status],
        ["Param", err.param],
      ]} />
    </>
  );
}

function SchemaValue({ value }) {
  const rows = schemaPropertyRows(value);
  return (
    <>
      <div class="structured-header">
        <strong>JSON Schema</strong>
        <div class="structured-badges">
          <Badge>{Array.isArray(value.type) ? value.type.join(" | ") : value.type}</Badge>
          <Badge tone={value.additionalProperties === false ? "ok" : ""}>
            {value.additionalProperties === false ? "strict" : value.additionalProperties === true ? "allows extra fields" : ""}
          </Badge>
        </div>
      </div>
      <KeyValueRows entries={[
        ["Required", Array.isArray(value.required) && value.required.length ? value.required : ""],
        ["Enum", Array.isArray(value.enum) && value.enum.length ? value.enum : ""],
      ]} />
      {rows.length > 0 && (
        <div class="structured-table-wrap">
          <table class="structured-table">
            <thead>
              <tr><th>Property</th><th>Type</th><th>Required</th><th>Enum</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td><code>{row.name}</code></td>
                  <td>{row.type}</td>
                  <td>{row.required ? <Badge tone="ok">yes</Badge> : <span class="structured-muted">no</span>}</td>
                  <td>{row.enum || <span class="structured-muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ContentValue({ value }) {
  const content = Array.isArray(value) ? value : value.content;
  return (
    <>
      <div class="structured-header">
        <strong>Content</strong>
        <Badge>{content.length} item{content.length === 1 ? "" : "s"}</Badge>
      </div>
      <div class="structured-content-list">
        {content.map((item, index) => (
          <div class="structured-content-item" key={index}>
            <Badge>{item.type || "item"}</Badge>
            {isObject(item.content) || Array.isArray(item.content)
              ? <NestedValue value={item.content} />
              : <span>{item.text || item.content || structuredPreview(item)}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

function GenericValue({ value }) {
  if (Array.isArray(value)) {
    return (
      <>
        <div class="structured-header"><strong>Array</strong><Badge>{value.length} item{value.length === 1 ? "" : "s"}</Badge></div>
        <ol class="structured-array">
          {value.slice(0, 20).map((item, index) => <li key={index}><NestedValue value={item} /></li>)}
        </ol>
        {value.length > 20 && <div class="structured-muted">Showing first 20 items.</div>}
      </>
    );
  }
  if (isObject(value)) {
    return (
      <>
        <div class="structured-header"><strong>Object</strong><Badge>{Object.keys(value).length} fields</Badge></div>
        <KeyValueRows entries={Object.entries(value)} />
      </>
    );
  }
  return <Scalar value={value} />;
}

export function StructuredValue({ value, title, hideRaw = false, class: className = "" }) {
  const parsed = parseMaybeJson(value);
  const data = parsed.value;
  const raw = rawJsonText(data);
  const kind = structuredKind(data);

  if (kind === "text") return <pre class={`structured-plain ${className}`.trim()}>{String(data ?? "")}</pre>;

  return (
    <div class={`structured-value structured-${kind} ${className}`.trim()}>
      <div class="structured-actions">
        {title && <span class="structured-title">{title}</span>}
        <CopyRawButton raw={raw} />
      </div>
      {kind === "worklab" ? <WorklabResult value={data} /> :
        kind === "error" ? <ErrorValue value={data} /> :
          kind === "schema" ? <SchemaValue value={data} /> :
            kind === "content" ? <ContentValue value={data} /> :
              <GenericValue value={data} />}
      {!hideRaw && <RawDisclosure raw={raw} />}
    </div>
  );
}
