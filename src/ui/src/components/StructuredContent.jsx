import { MarkdownContent } from "./Markdown.jsx";
import { StructuredValue } from "./StructuredValue.jsx";
import { splitStructuredText } from "../lib/structuredValue.js";

export function StructuredContent({
  content = "",
  className = "markdown doc-content",
  maxHeight = 320,
  expandable = true,
  mentions = null,
}) {
  const segments = splitStructuredText(content);
  if (segments.length === 0) return null;
  if (segments.length === 1 && segments[0].type === "markdown") {
    return <MarkdownContent content={segments[0].text} className={className} maxHeight={maxHeight} expandable={expandable} mentions={mentions} />;
  }
  return (
    <div class={`structured-content ${className}`.trim()}>
      {segments.map((segment, index) => (
        segment.type === "structured"
          ? <StructuredValue key={index} value={segment.value} />
          : <MarkdownContent key={index} content={segment.text} className="structured-markdown doc-content" maxHeight={maxHeight} expandable={expandable} mentions={mentions} />
      ))}
    </div>
  );
}
