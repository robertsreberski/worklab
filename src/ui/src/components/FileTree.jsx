import { Icon } from "./Icon.jsx";

function fileTreeIcon(type) {
  if (type === "folder") return "folder";
  if (type === "symlink") return "link";
  return "file-text";
}

function FileTreeNode({ node, depth = 0, renderMeta, highlightSkillFile = false, getNodeClass, onFileClick, canFileClick }) {
  const isFolder = node.type === "folder";
  const isSkillFile = highlightSkillFile && node.name === "SKILL.md";
  const meta = renderMeta?.(node);
  const extraClass = getNodeClass?.(node) || "";
  const clickable = !isFolder
    && typeof onFileClick === "function"
    && (!canFileClick || canFileClick(node));
  const rowProps = {
    class: `skill-file-tree-row ${meta ? "has-meta" : ""} ${clickable ? "is-clickable" : ""}`.trim(),
    style: { "--indent": `${depth * 18}px` },
  };
  const rowContent = (
    <>
      <Icon name={fileTreeIcon(node.type)} size={14} />
      <span class="skill-file-tree-name" title={node.path || node.name}>{node.name}</span>
      {meta && <span class="skill-file-tree-meta">{meta}</span>}
    </>
  );
  return (
    <li class={`skill-file-tree-item ${isFolder ? "is-folder" : "is-file"} ${isSkillFile ? "is-skill-file" : ""} ${extraClass}`.trim()}>
      {clickable ? (
        <button type="button" {...rowProps} onClick={() => onFileClick(node)}>
          {rowContent}
        </button>
      ) : (
        <div {...rowProps}>{rowContent}</div>
      )}
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
              onFileClick={onFileClick}
              canFileClick={canFileClick}
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
  onFileClick,
  canFileClick,
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
          onFileClick={onFileClick}
          canFileClick={canFileClick}
        />
      ))}
    </ul>
  );
}
