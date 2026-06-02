// §4.18 CodeBlock — standalone code display (no syntax highlighting in v1).
import { useState } from "preact/hooks";
import { IconButton } from "./primitives/IconButton.jsx";
import { Icon } from "./Icon.jsx";

async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); } catch { /* best-effort */ }
}

export function CodeBlock({ code = "", language, class: className = "" }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class={`code-block ${className}`.trim()}>
      <div class="code-block-head">
        <span>{language || "code"}</span>
        <IconButton
          size="sm"
          icon={<Icon name={copied ? "check" : "copy"} size={12} />}
          aria-label="Copy code"
          onClick={() => writeClipboard(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })}
        />
      </div>
      <pre class="code-block-pre"><code>{code}</code></pre>
    </div>
  );
}
