// §6.6 SkillEdit — metadata (display name, priority, enabled) · trigger · body.
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { AdvancedMeta } from "../components/AdvancedMeta.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { Modal } from "../components/Modal.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Card } from "../components/Card.jsx";
import { Icon } from "../components/Icon.jsx";
import { humanizeSlug, skillDisplayName } from "../lib/display.js";
import { useUnsavedChangesGuard } from "../lib/navigation.js";

const emptySkill = { name: "", meta: { display_name: "", trigger: "", enabled: true, priority: "" }, body: "" };

function fileTreeIcon(type) {
  if (type === "folder") return "folder";
  if (type === "symlink") return "link";
  return "file-text";
}

function SkillFileTreeNode({ node, depth = 0 }) {
  const isFolder = node.type === "folder";
  const isSkillFile = node.name === "SKILL.md";
  return (
    <li class={`skill-file-tree-item ${isFolder ? "is-folder" : "is-file"} ${isSkillFile ? "is-skill-file" : ""}`.trim()}>
      <div class="skill-file-tree-row" style={{ "--indent": `${depth * 18}px` }}>
        <Icon name={fileTreeIcon(node.type)} size={14} />
        <span class="skill-file-tree-name">{node.name}</span>
      </div>
      {isFolder && node.children?.length > 0 && (
        <ul class="skill-file-tree-list">
          {node.children.map((child) => (
            <SkillFileTreeNode key={`${child.type}:${child.name}`} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SkillFileTree({ files = [] }) {
  if (!files.length) {
    return <div class="field-hint">No files found.</div>;
  }
  return (
    <ul class="skill-file-tree-list skill-file-tree-root" aria-label="Skill files">
      {files.map((node) => (
        <SkillFileTreeNode key={`${node.type}:${node.name}`} node={node} />
      ))}
    </ul>
  );
}

export function SkillEdit({ name, onSaved, onDeleted }) {
  const isNew = name === "new";
  const [skill, setSkill] = useState(isNew ? emptySkill : null);
  const [baseline, setBaseline] = useState(null);
  const [usage, setUsage] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!isNew) {
      api.getSkill(name).then(r => { setSkill(r.skill); setBaseline(r.skill); }).catch(() => setSkill({ notFound: true }));
      api.skillUsage(name).then(setUsage).catch(() => {});
    } else {
      setSkill(emptySkill);
      setBaseline(emptySkill);
      setUsage(null);
    }
  }, [name, isNew]);

  const isDirty = useMemo(() => baseline ? JSON.stringify(skill) !== JSON.stringify(baseline) : true, [skill, baseline]);
  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => formSave.save() });

  const formSave = useFormSave(async () => {
    const payload = {
      meta: { ...skill.meta, trigger: skill.meta.trigger, enabled: !!skill.meta.enabled },
      body: skill.body,
    };
    if (!skill.meta.priority) delete payload.meta.priority;
    if (isNew) {
      const res = await api.createSkill({ ...payload });
      pushToast("Skill created", { variant: "success" });
      setBaseline(skill);
      onSaved?.(res.skill.name);
    } else {
      await api.patchSkill(name, payload);
      pushToast("Saved.", { variant: "success" });
      setBaseline(skill);
      onSaved?.(name);
    }
  });

  useGlobalShortcuts({
    cmds: (e) => { e.preventDefault(); formSave.save().catch(() => {}); },
  });

  if (!skill) return <LoadingState caption="Loading skill…" />;
  if (skill.notFound) return (
    <div class="pane-empty">
      <h3>Skill not found</h3>
      <p>This skill may have been deleted.</p>
    </div>
  );

  async function destroy() {
    try {
      await api.deleteSkill(name);
      pushToast("Skill deleted", { variant: "success" });
      onDeleted?.();
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  const title = isNew ? "New skill" : skillDisplayName(skill);
  const slugLabel = isNew ? "Slug after create" : skill.name;
  const priorityLabel = skill.meta.priority === "always" ? "Always inline" : "On demand";
  const usageCount = usage?.explicit?.length || 0;

  return (
    <>
      <header class="pane-detail-head skill-detail-head">
        <div class="pane-detail-head-copy">
          <div class="pane-detail-icon skill-detail-icon" aria-hidden="true">
            <Icon name="sparkles" size={16} />
          </div>
          <div class="pane-detail-head-titles">
            <div class="all-caps">{isNew ? "Create skill" : "Skill"}</div>
            <h2>{title}</h2>
            <div class="pane-detail-subline">
              <span class="pane-row-mono">{slugLabel}</span>
              <span class="pane-row-dot">·</span>
              <span>{priorityLabel}</span>
              {!isNew && (
                <>
                  <span class="pane-row-dot">·</span>
                  <span>{usageCount} explicit agent{usageCount === 1 ? "" : "s"}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div class="toolbar">
          {!isNew && <StatusPill status={skill.meta.enabled !== false ? "enabled" : "disabled"} />}
          <Button
            variant={isDirty || isNew ? "primary" : "secondary"}
            loading={formSave.saving}
            disabled={!(skill.meta.display_name || skill.name)}
            onClick={() => formSave.save().catch(() => {})}
          >
            {isNew ? "Create" : "Save"}
          </Button>
        </div>
      </header>
      <div class="pane-detail-body">
        {formSave.error && (
          <Banner variant="error" title="Save failed" detail={formSave.error} actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>} />
        )}

        <FormSection kicker="Metadata" title="Activation">
          <FormGrid columns={2}>
            <FormField label="Display name" required class="span-2">
              <Input
                value={skill.meta.display_name || (isNew ? "" : humanizeSlug(skill.name))}
                onInput={(e) => setSkill({ ...skill, meta: { ...skill.meta, display_name: e.target.value } })}
              />
            </FormField>
            <FormField label="Priority">
              <Select
                value={skill.meta.priority || ""}
                options={[
                  { value: "", label: "On demand" },
                  { value: "always", label: "Always inline full body" },
                ]}
                onChange={(v) => setSkill({ ...skill, meta: { ...skill.meta, priority: v || undefined } })}
              />
            </FormField>
            <FormField switchInside>
              <Switch
                checked={skill.meta.enabled !== false}
                onChange={(next) => setSkill({ ...skill, meta: { ...skill.meta, enabled: next } })}
                label="Available to agents"
                description="Unavailable skills stay saved but are not offered to agents."
              />
            </FormField>
            <FormField label="Trigger" class="span-2">
              <Input
                placeholder="When should this skill activate?"
                value={skill.meta.trigger || ""}
                onInput={(e) => setSkill({ ...skill, meta: { ...skill.meta, trigger: e.target.value } })}
              />
            </FormField>
          </FormGrid>
          <AdvancedMeta items={[{ label: "Slug", value: isNew ? "Generated after create" : skill.name }]} />
        </FormSection>

        {!isNew && (
          <FormSection kicker="Files" title="File tree">
            <SkillFileTree files={skill.files || []} />
          </FormSection>
        )}

        <FormSection kicker="Playbook" title="Body (Markdown)">
          <Textarea
            rows={22}
            monospace
            autoGrow
            value={skill.body}
            onInput={(e) => setSkill({ ...skill, body: e.target.value })}
          />
        </FormSection>

        {!isNew && usage && usage.explicit?.length > 0 && (
          <FormSection kicker="References" title="Used by agents">
            <ul class="usage-list">
              {usage.explicit.map((a) => (
                <li key={a.name}><a href={`#/agents/${a.name}`}>{a.display_name || a.name}</a></li>
              ))}
            </ul>
          </FormSection>
        )}

        {!isNew && (
          <Card collapsible={{ summary: "More actions", count: 1 }}>
            <Button
              variant="destructive"
              iconLeft={<Icon name="trash" size={13} />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete skill
            </Button>
          </Card>
        )}
      </div>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete "${title}"?`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setDeleteOpen(false); destroy(); }}>Delete</Button>
          </>
        }
      >
        <p>This removes the skill permanently.</p>
      </Modal>

      <Modal
        open={guard.promptOpen}
        onClose={guard.keepEditing}
        title="You have unsaved changes"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={guard.keepEditing}>Keep editing</Button>
            <Button variant="destructive" onClick={guard.discardAndLeave}>Discard</Button>
            <Button variant="primary" loading={formSave.saving} onClick={() => guard.saveAndLeave().catch(() => {})}>
              Save & leave
            </Button>
          </>
        }
      >
        <p>Your changes have not been saved.</p>
      </Modal>
    </>
  );
}
