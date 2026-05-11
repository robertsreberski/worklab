// §6.6 SkillEdit — metadata (display name, priority, enabled) · trigger · body.
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
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
import { MobilePillRow, MobileTopbar } from "../components/AppShell.jsx";
import { EntityChromeBridge } from "../components/EntityChromeBridge.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { Modal } from "../components/Modal.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Card } from "../components/Card.jsx";
import { EntityMetaList } from "../components/EntityMetaList.jsx";
import { FileTree } from "../components/FileTree.jsx";
import { Icon } from "../components/Icon.jsx";
import { DetailHead, SectionMarker } from "../components/layout/index.js";
import { humanizeSlug, skillDisplayName } from "../lib/display.js";
import { useUnsavedChangesGuard } from "../lib/navigation.js";
import { useAppResume } from "../lib/pageVisibility.js";

const emptySkill = { name: "", meta: { display_name: "", trigger: "", enabled: true, priority: "" }, body: "" };
const SKILL_EDIT_SECTIONS = [
  { id: "skill-edit-activation", num: "01", label: "Activation", meta: "Trigger" },
  { id: "skill-edit-body", num: "02", label: "Body", meta: "Playbook" },
];

export function SkillFileTree({ files = [] }) {
  return <FileTree files={files} ariaLabel="Skill files" emptyText="No files found." highlightSkillFile />;
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

  const formSave = useFormSave(async () => {
    const payload = {
      meta: { ...skill.meta, trigger: skill.meta.trigger, enabled: !!skill.meta.enabled },
      body: skill.body,
    };
    if (!skill.meta.priority) {
      if (isNew) delete payload.meta.priority;
      else payload.meta.priority = null;
    }
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
  const isDirty = useMemo(() => baseline ? JSON.stringify(skill) !== JSON.stringify(baseline) : true, [skill, baseline]);
  useAppResume(() => {
    if (isNew) return;
    if (!isDirty) {
      api.getSkill(name)
        .then((r) => {
          setSkill(r.skill);
          setBaseline(r.skill);
        })
        .catch(() => setSkill({ notFound: true }));
    }
    api.skillUsage(name).then(setUsage).catch(() => {});
  });
  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => formSave.save() });
  const cancel = useCallback(() => {
    guard.requestNavigation("#/library/skills");
  }, [guard.requestNavigation]);

  useGlobalShortcuts({
    cmds: (e) => { e.preventDefault(); formSave.save().catch(() => {}); },
    Escape: () => cancel(),
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
  const fileCount = Array.isArray(skill.files) ? skill.files.length : 0;
  const contextMeta = [
    { label: "Slug", value: isNew ? "Generated after create" : skill.name },
    { label: "Availability", value: skill.meta.enabled !== false ? "Available" : "Disabled", mono: false },
    { label: "Priority", value: priorityLabel, mono: false },
    !isNew ? { label: "Used by", value: `${usageCount} explicit agent${usageCount === 1 ? "" : "s"}`, mono: false } : null,
    !isNew ? { label: "Files", value: `${fileCount} root item${fileCount === 1 ? "" : "s"}`, mono: false } : null,
  ];
  const saveButtonVariant = isDirty || isNew ? "primary" : "secondary";
  const saveButtonLabel = isNew ? "Create" : "Save";
  const saveDisabled = !(skill.meta.display_name || skill.name);
  const headerActions = (
    <>
      {!isNew && <StatusPill status={skill.meta.enabled !== false ? "enabled" : "disabled"} />}
      <Button variant="ghost" onClick={cancel}>Cancel</Button>
      <Button
        variant={saveButtonVariant}
        loading={formSave.saving}
        disabled={saveDisabled}
        onClick={() => formSave.save().catch(() => {})}
      >
        {saveButtonLabel}
      </Button>
    </>
  );
  const mobileActionDock = (
    <>
      <Button variant="secondary" onClick={cancel}>Cancel</Button>
      <Button
        variant={saveButtonVariant}
        loading={formSave.saving}
        disabled={saveDisabled}
        onClick={() => formSave.save().catch(() => {})}
      >
        {saveButtonLabel}
      </Button>
    </>
  );

  function renderSkillRail() {
    return (
      <div class="entity-editor-rail-content">
        <Card variant="spacious" title="Context" class="entity-rail-card">
          <EntityMetaList items={contextMeta} />
        </Card>

        {!isNew && (
          <Card variant="spacious" title="File tree" class="entity-rail-card skill-files-card">
            <SkillFileTree files={skill.files || []} />
          </Card>
        )}

        {!isNew && usage && usage.explicit?.length > 0 && (
          <Card variant="spacious" title="Used by agents" class="entity-rail-card">
            <ul class="usage-list">
              {usage.explicit.map((a) => (
                <li key={a.name}><a href={`#/library/agents/${encodeURIComponent(a.name)}`}>{a.display_name || a.name}</a></li>
              ))}
            </ul>
          </Card>
        )}

        {!isNew && (
          <Card collapsible={{ summary: "More actions", count: 1 }} class="entity-rail-card">
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
    );
  }

  return (
    <>
      <EntityChromeBridge
        chrome={{
          mobileTopbar: <MobileTopbar title={isNew ? "New skill" : slugLabel} backLabel="Skills" onBack={cancel} />,
          mobileActionDock,
          drawerTitle: "Settings",
          drawerKicker: slugLabel,
          drawerContent: renderSkillRail(),
          sections: SKILL_EDIT_SECTIONS,
        }}
      />
      <DetailHead
        class="skill-detail-head entity-edit-head"
        backLabel="All skills"
        onBack={cancel}
        crumbs={[
          { label: "Skills", href: "#/library/skills" },
          { label: isNew ? "New" : "Edit" },
        ]}
        icon={<Icon name="sparkles" size={16} />}
        iconClass="skill-detail-icon"
        kicker={isNew ? "Create skill" : "Skill"}
        title={title}
        meta={(
          <>
            <span class="pane-row-mono">{slugLabel}</span>
            <span class="pane-row-dot">·</span>
            <span>{priorityLabel}</span>
            {!isNew && (
              <>
                <span class="pane-row-dot">·</span>
                <span>{usageCount} explicit agent{usageCount === 1 ? "" : "s"}</span>
              </>
            )}
          </>
        )}
        actions={headerActions}
        subBar={<MobilePillRow railLabel="Settings" railCount={isNew ? 1 : 3} sections={SKILL_EDIT_SECTIONS} />}
      />
      <div class="pane-detail-body entity-detail-body skill-detail-body">
        {formSave.error && (
          <Banner variant="error" title="Save failed" detail={formSave.error} actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>} />
        )}

        <div class="entity-editor-layout skill-editor-layout">
          <main class="entity-editor-main">
            <SectionMarker id="skill-edit-activation" num="01" kicker="Activation" meta="Trigger" />
            <FormSection kicker="Definition" title="Activation">
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
                <FormField switchInside class="span-2">
                  <Switch
                    checked={skill.meta.enabled !== false}
                    onChange={(next) => setSkill({ ...skill, meta: { ...skill.meta, enabled: next } })}
                    label="Available to agents"
                    description="Unavailable skills stay saved but are not offered to agents."
                  />
                </FormField>
                <FormField label="Trigger" class="span-2" hint="Used to decide when agents should apply this playbook.">
                  <Input
                    placeholder="When should this skill activate?"
                    value={skill.meta.trigger || ""}
                    onInput={(e) => setSkill({ ...skill, meta: { ...skill.meta, trigger: e.target.value } })}
                  />
                </FormField>
              </FormGrid>
            </FormSection>

            <SectionMarker id="skill-edit-body" num="02" kicker="Body" meta="Playbook" />
            <FormSection kicker="Playbook" title="Skill body">
              <Textarea
                class="skill-body-editor"
                rows={28}
                monospace
                autoGrow
                value={skill.body}
                onInput={(e) => setSkill({ ...skill, body: e.target.value })}
              />
            </FormSection>
          </main>

          <aside class="entity-editor-rail is-mobile-drawer-source">
            {renderSkillRail()}
          </aside>
        </div>
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
        size="md"
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
