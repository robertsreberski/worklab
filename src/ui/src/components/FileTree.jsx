import { Icon } from "./Icon.jsx";

function fileTreeIcon(type) {
  if (type === "folder") return "folder";
  if (type === "symlink") return "link";
  return "file-text";
}

function FileTreeNode({ node, depth = 0, renderMeta, highlightSkillFile = false, getNodeClass }) {
  const isFolder = node.type === "folder";
  const isSkillFile = highlightSkillFile && node.name === "SKILL.md";
  const meta = renderMeta?.(node);
  const extraClass = getNodeClass?.(node) || "";
  return (
    <li class={`skill-file-tree-item ${isFolder ? "is-folder" : "is-file"} ${isSkillFile ? "is-skill-file" : ""} ${extraClass}`.trim()}>
      <div class={`skill-file-tree-row ${meta ? "has-meta" : ""}`.trim()} style={{ "--indent": `${depth * 18}px` }}>
        <Icon name={fileTreeIcon(node.type)} size={14} />
        <span class="skill-file-tree-name" title={node.path || node.name}>{node.name}</span>
        {meta && <span class="skill-file-tree-meta">{meta}</span>}
      </div>
      {isFolder && node.children?.length > 0 && (
        <ul class="skill-file-tree-list">
          {node.children.map((child) => (
            <FileTreeNode
              key={`${child.type}:${child.name}:${child.path || ""}`}
              node={child}
              depth={depth + 1}
              renderMeta={renderMeta}
              highlightSkillFile={highlightSkillFile}
              getNodeClass={getNodeClass}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FileTree({
  files = [],
  ariaLabel = "Files",
  emptyText = "No files found.",
  renderMeta,
  highlightSkillFile = false,
  getNodeClass,
}) {
  if (!files.length) {
    return <div class="field-hint">{emptyText}</div>;
  }
  return (
    <ul class="skill-file-tree-list skill-file-tree-root" aria-label={ariaLabel}>
      {files.map((node) => (
        <FileTreeNode
          key={`${node.type}:${node.name}:${node.path || ""}`}
          node={node}
          renderMeta={renderMeta}
          highlightSkillFile={highlightSkillFile}
          getNodeClass={getNodeClass}
        />
      ))}
    </ul>
  );
}
