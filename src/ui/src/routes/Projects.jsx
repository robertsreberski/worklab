import { useEffect, useMemo, useState, useCallback, useRef } from "preact/hooks";
import { api } from "../lib/api.js";
import { navigateHash, proceedToHash, useUnsavedChangesGuard } from "../lib/navigation.js";
import { taskRouteId } from "../lib/display.js";
import { useSSE } from "../lib/useSSE.js";
import { useThrottledCallback } from "../lib/useThrottledCallback.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { AppShell, MobilePillRow, MobileTopbar, useAppChrome } from "../components/AppShell.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { PaneListHeader, DetailHead, SectionMarker } from "../components/layout/index.js";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { TagInput } from "../components/primitives/SpecialInputs.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Card } from "../components/Card.jsx";
import { FormField } from "../components/FormField.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { EntityMetaList } from "../components/EntityMetaList.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Banner } from "../components/Banner.jsx";
import { MarkdownContent } from "../components/Markdown.jsx";
import { Icon } from "../components/Icon.jsx";
import { pushToast } from "../lib/toast.js";

const PROJECT_SECTIONS = [
  { id: "project-details", num: "01", label: "Details", meta: "Context" },
  { id: "project-tasks", num: "02", label: "Tasks", meta: "Membership" },
];

const PROJECT_EDIT_SECTIONS = [
  { id: "project-edit-details", num: "01", label: "Details", meta: "Metadata" },
  { id: "project-edit-context", num: "02", label: "Context", meta: "Markdown" },
];

function EntityChromeBridge({ chrome }) {
  useAppChrome(chrome, [chrome]);
  return null;
}

function projectRouteId(project) {
  return encodeURIComponent(project?.slug || project?.id || "");
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
function slugLooksValid(value) {
  if (!value) return true;
  return SLUG_PATTERN.test(value);
}

function projectDraftFrom(project = {}) {
  return {
    name: project.name || "",
    slug: project.slug || "",
    description: project.description || "",
    context: project.context || "",
    workdir: project.workdir || "",
    tags: project.tags || [],
    archived: !!project.archived,
  };
}

function formatProjectAge(value) {
  if (!value) return "";
  const ms = Date.now() - Number(value);
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 86_400_000 * 7) return `${Math.floor(ms / 86_400_000)}d`;
  return new Date(Number(value)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ProjectEditor({ selectedId, onSaved }) {
  const isNew = selectedId === "new";
  const [draft, setDraft] = useState(projectDraftFrom());
  const [baseline, setBaseline] = useState(projectDraftFrom());
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    if (isNew) {
      const empty = projectDraftFrom();
      setDraft(empty);
      setBaseline(empty);
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    api.getProject(selectedId, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        const next = projectDraftFrom(res.project);
        setDraft(next);
        setBaseline(next);
      })
      .catch((err) => { if (err?.name !== "AbortError") setError(err.message || "Project not found"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [isNew, selectedId]);

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline]);
  const slugTrimmed = draft.slug.trim();
  const slugValid = slugLooksValid(slugTrimmed);
  const canSave = !!draft.name.trim() && slugValid;

  function update(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function save({ navigateOnSuccess = true } = {}) {
    if (!draft.name.trim()) {
      pushToast("Project name is required", { variant: "error" });
      throw new Error("Project name is required");
    }
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        slug: draft.slug.trim() || undefined,
        description: draft.description,
        context: draft.context,
        workdir: draft.workdir.trim() || null,
        tags: draft.tags || [],
        archived: !!draft.archived,
      };
      const res = isNew
        ? await api.createProject(payload)
        : await api.patchProject(selectedId, payload);
      const saved = projectDraftFrom(res.project);
      setDraft(saved);
      setBaseline(saved);
      onSaved?.();
      pushToast(isNew ? "Project created" : "Project saved", { variant: "success" });
      if (navigateOnSuccess) proceedToHash(`#/projects/${projectRouteId(res.project)}`);
      return res.project;
    } catch (err) {
      setError(err.message || "Save failed");
      throw err;
    } finally {
      setSaving(false);
    }
  }

  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => save({ navigateOnSuccess: false }) });
  const cancel = () => guard.requestNavigation(isNew ? "#/projects" : `#/projects/${encodeURIComponent(selectedId)}`);

  useGlobalShortcuts({
    cmds: (event) => { event.preventDefault(); save().catch(() => {}); },
    Escape: () => cancel(),
  });

  const chrome = {
    mobileTopbar: <MobileTopbar title={isNew ? "New project" : draft.slug || selectedId} backLabel="Projects" onBack={cancel} />,
    mobileActionDock: (
      <>
        <Button variant="secondary" onClick={cancel}>Cancel</Button>
        <Button variant={isDirty || isNew ? "primary" : "secondary"} loading={saving} disabled={!canSave} onClick={() => save().catch(() => {})}>
          {isNew ? "Create" : "Save"}
        </Button>
      </>
    ),
    drawerTitle: "Details",
    drawerKicker: isNew ? "New" : draft.slug,
    drawerContent: (
      <div class="entity-editor-rail-content">
        <Card variant="spacious" title="Project" class="entity-rail-card">
          <EntityMetaList items={[
            { label: "Slug", value: isNew ? "Generated on create" : draft.slug },
            { label: "Workdir", value: draft.workdir || "Default workspace", mono: false },
            { label: "Tags", value: `${(draft.tags || []).length}`, mono: false },
            { label: "Archived", value: draft.archived ? "Yes" : "No", mono: false },
          ]} />
        </Card>
      </div>
    ),
    sections: PROJECT_EDIT_SECTIONS,
  };

  if (loading) return <LoadingState caption="Loading project..." />;

  return (
    <>
      <EntityChromeBridge chrome={chrome} />
      <DetailHead
        class="project-detail-head"
        crumbs={[{ label: "Projects", href: "#/projects" }, { label: isNew ? "New" : draft.slug || selectedId }]}
        icon={<Icon name="folder" size={16} />}
        kicker={isNew ? "Create project" : "Project editor"}
        title={draft.name || "Untitled project"}
        meta={<span class="pane-row-mono">{isNew ? "New project" : draft.slug}</span>}
        actions={(
          <>
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
            <Button variant={isDirty || isNew ? "primary" : "secondary"} loading={saving} disabled={!canSave} onClick={() => save().catch(() => {})}>
              {isNew ? "Create" : "Save"}
            </Button>
          </>
        )}
        subBar={<MobilePillRow railLabel="Details" railCount={1} sections={PROJECT_EDIT_SECTIONS} />}
      />
      <div class="pane-detail-body entity-detail-body project-detail-body">
        {error && <Banner variant="error" title="Project save failed" detail={error} />}
        <div class="entity-editor-layout project-editor-layout">
          <main class="entity-editor-main">
            <SectionMarker id="project-edit-details" num="01" kicker="Details" meta="Metadata" />
            <FormSection kicker="Metadata" title="Project details">
              <FormGrid columns={2}>
                <FormField label="Name" required>
                  <Input value={draft.name} onInput={(event) => update({ name: event.currentTarget.value })} placeholder="Project name" autoFocus={isNew} />
                </FormField>
                <FormField
                  label="Slug"
                  hint={slugValid ? "Lowercase letters, digits, and hyphens." : null}
                  error={slugValid ? null : "Slug must use lowercase letters, digits, and hyphens (no leading/trailing dash)."}
                >
                  <Input
                    value={draft.slug}
                    onInput={(event) => update({ slug: event.currentTarget.value })}
                    placeholder="generated-from-name"
                    aria-invalid={!slugValid}
                  />
                </FormField>
                <FormField label="Description">
                  <Input value={draft.description} onInput={(event) => update({ description: event.currentTarget.value })} placeholder="Short summary" />
                </FormField>
                <FormField label="Workdir" hint="Optional. Overrides the default workspace for assigned task runs.">
                  <Input value={draft.workdir} onInput={(event) => update({ workdir: event.currentTarget.value })} placeholder="/path/to/project" />
                </FormField>
                <FormField label="Tags">
                  <TagInput value={draft.tags || []} onChange={(tags) => update({ tags })} placeholder="Add tag..." />
                </FormField>
                <FormField switchInside>
                  <Switch
                    checked={draft.archived}
                    onChange={(archived) => update({ archived })}
                    label="Archived"
                    description="Hide from default project lists without removing task links."
                  />
                </FormField>
              </FormGrid>
            </FormSection>

            <SectionMarker id="project-edit-context" num="02" kicker="Context" meta="Markdown" />
            <FormSection kicker="Run context" title="Context inserted into assigned task runs">
              <Textarea rows={18} monospace autoGrow value={draft.context} onInput={(event) => update({ context: event.currentTarget.value })} />
            </FormSection>
          </main>
        </div>
      </div>
    </>
  );
}

function ProjectDetail({ selectedId, onChanged }) {
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const reloadAbortRef = useRef(null);

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    setProject(null);
    setError(null);
    return api.getProject(selectedId, { signal: controller.signal })
      .then((res) => { if (!controller.signal.aborted) setProject(res.project); })
      .catch((err) => { if (err?.name !== "AbortError") setError(err.message || "Project not found"); });
  }, [selectedId]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => () => reloadAbortRef.current?.abort?.(), []);

  const rail = useMemo(() => {
    if (!project) return null;
    return (
      <div class="entity-editor-rail-content project-read-rail-content">
        <Card variant="spacious" title="Project" class="entity-rail-card">
          <EntityMetaList items={[
            { label: "Slug", value: project.slug },
            { label: "Workdir", value: project.workdir || "Default workspace", mono: false },
            { label: "Tasks", value: String(project.stats?.task_count || 0), mono: false },
            { label: "Tags", value: project.tags?.length ? project.tags.join(", ") : "None", mono: false },
            { label: "Updated", value: formatProjectAge(project.updated_at), mono: false },
            { label: "Archived", value: project.archived ? "Yes" : "No", mono: false },
          ]} />
        </Card>
      </div>
    );
  }, [project]);

  if (error) {
    return (
      <div class="pane-empty">
        <Icon name="folder" size={28} />
        <h3>Project not found</h3>
        <p>{error}</p>
      </div>
    );
  }
  if (!project) return <LoadingState caption="Loading project..." />;

  async function archiveProject() {
    try {
      await api.archiveProject(project.id);
      pushToast("Project archived", { variant: "success" });
      onChanged?.();
      navigateHash("#/projects");
    } catch (err) {
      pushToast(`Archive failed: ${err.message}`, { variant: "error" });
    }
  }

  return (
    <>
      <EntityChromeBridge
        chrome={{
          mobileTopbar: <MobileTopbar title={project.slug} backLabel="Projects" onBack={() => navigateHash("#/projects")} />,
          drawerTitle: "Details",
          drawerKicker: project.slug,
          drawerContent: rail,
          sections: PROJECT_SECTIONS,
        }}
      />
      <DetailHead
        class="project-detail-head project-read-head"
        crumbs={[{ label: "Projects", href: "#/projects" }, { label: project.name }]}
        icon={<Icon name="folder" size={16} />}
        kicker="Project"
        title={project.name}
        meta={(
          <>
            <span class="pane-row-mono">{project.slug}</span>
            <span class="pane-row-dot">·</span>
            <span>{project.stats?.task_count || 0} task{project.stats?.task_count === 1 ? "" : "s"}</span>
            {project.archived && (
              <>
                <span class="pane-row-dot">·</span>
                <span>Archived</span>
              </>
            )}
          </>
        )}
        actions={(
          <>
            {project.archived && <Chip variant="muted">Archived</Chip>}
            <Button variant="secondary" iconLeft={<Icon name="edit-3" size={13} />} onClick={() => navigateHash(`#/projects/${projectRouteId(project)}/edit`)}>
              Edit
            </Button>
            {!project.archived && (
              <Button variant="secondary" iconLeft={<Icon name="minus-circle" size={13} />} onClick={archiveProject}>
                Archive
              </Button>
            )}
          </>
        )}
        subBar={<MobilePillRow railLabel="Details" railCount={1} sections={PROJECT_SECTIONS} />}
      />
      <div class="pane-detail-body entity-detail-body project-detail-body">
        <div class="knowledge-read-layout project-read-layout">
          <main class="knowledge-read-main project-read-main">
            <section class="knowledge-read-section" aria-labelledby="project-details">
              <SectionMarker id="project-details" num="01" kicker="Context" meta="Run input" />
              {project.description && <p class="soft-meta project-description">{project.description}</p>}
              <div class="project-workdir-row">
                <span class="project-workdir-label">Workdir</span>
                <span class="project-workdir-value mono">{project.workdir || "Default workspace"}</span>
                {project.workdir && (
                  <Button
                    variant="ghost"
                    iconLeft={<Icon name="copy" size={11} />}
                    onClick={() => {
                      navigator.clipboard?.writeText(project.workdir).then(
                        () => pushToast("Workdir copied", { variant: "success" }),
                        () => pushToast("Copy failed", { variant: "error" }),
                      );
                    }}
                  >
                    Copy
                  </Button>
                )}
              </div>
              {project.context?.trim() ? (
                <article class="knowledge-read-article">
                  <MarkdownContent content={project.context} className="markdown doc-content knowledge-read-markdown" expandable={false} />
                </article>
              ) : (
                <div class="task-plan-empty">No project context yet.</div>
              )}
            </section>

            <section class="knowledge-read-section" aria-labelledby="project-tasks">
              <SectionMarker id="project-tasks" num="02" kicker="Tasks" meta={`${project.tasks?.length || 0} linked`} />
              {project.tasks?.length ? (
                <ul class="usage-list project-task-list">
                  {project.tasks.map((task) => (
                    <li key={task.id}>
                      <a href={`#/tasks/${taskRouteId(task)}`}>{task.title}</a>{" "}
                      <StatusPill status={task.stage || "plan"} size="sm" />
                    </li>
                  ))}
                </ul>
              ) : (
                <div class="task-plan-empty">No tasks are assigned to this project.</div>
              )}
            </section>
          </main>
          <aside class="entity-editor-rail project-read-rail is-mobile-drawer-source">{rail}</aside>
        </div>
      </div>
    </>
  );
}

export function Projects({ selectedId = null, mode = null }) {
  const [projects, setProjects] = useState([]);
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const searchRef = useRef(null);
  const reloadAbortRef = useRef(null);

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    api.listProjects({ include_archived: includeArchived ? "true" : "" }, { signal: controller.signal })
      .then((res) => { if (!controller.signal.aborted) setProjects(res.projects || []); })
      .catch((err) => { if (err?.name !== "AbortError") setProjects([]); });
  }, [includeArchived]);
  const reloadSoon = useThrottledCallback(reload, 100);
  const reloadEventually = useThrottledCallback(reload, 1500);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => () => reloadAbortRef.current?.abort?.(), []);
  useSSE("global", (evt) => {
    if (evt.type?.startsWith("project_")) reloadSoon();
    else if (evt.type?.startsWith("task_")) reloadEventually();
  });
  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((project) =>
      project.name?.toLowerCase().includes(q) ||
      project.slug?.toLowerCase().includes(q) ||
      project.description?.toLowerCase().includes(q) ||
      project.context?.toLowerCase().includes(q) ||
      (project.tags || []).some((tag) => tag.toLowerCase().includes(q))
    );
  }, [projects, query]);

  const listHeader = (
    <PaneListHeader
      searchValue={query}
      onSearch={setQuery}
      searchPlaceholder="Search projects..."
      searchAriaLabel="Search projects"
      searchRef={searchRef}
      actionLabel="New project"
      onAction={() => navigateHash("#/projects/new")}
    >
      <label class="project-archive-toggle">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.currentTarget.checked)}
          aria-label="Show archived projects"
        />
        <span>Show archived</span>
      </label>
    </PaneListHeader>
  );

  const listBody = filtered.length === 0 ? (
    query.trim() ? (
      <EmptyStateFiltered body="No projects match." onClearFilters={() => setQuery("")} />
    ) : (
      <EmptyState
        icon={<Icon name="folder" size={48} />}
        title="No projects yet"
        body="Create a project to share context and a workdir across related tasks."
        cta={<Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => navigateHash("#/projects/new")}>New project</Button>}
      />
    )
  ) : (
    filtered.map((project) => (
      <PaneRow
        key={project.id}
        href={`#/projects/${projectRouteId(project)}`}
        active={project.slug === selectedId || project.id === selectedId}
        onClick={(event) => {
          event?.preventDefault?.();
          navigateHash(`#/projects/${projectRouteId(project)}`);
        }}
        leading={<span class="knowledge-row-leading"><Icon name="folder" size={12} /></span>}
        title={project.name}
        sub={(
          <span class="knowledge-row-sub">
            <span class="pane-row-mono">{project.slug}</span>
            {project.archived && <span class="kb-category-badge">archived</span>}
          </span>
        )}
        trailing={(
          <span class="pane-row-summary pane-row-summary-metrics">
            <span title={`${project.active_task_count || 0} active of ${project.task_count || 0} total`}>
              {project.active_task_count || 0}/{project.task_count || 0} task{project.task_count === 1 ? "" : "s"}
            </span>
            <span>{formatProjectAge(project.updated_at)}</span>
          </span>
        )}
      />
    ))
  );

  const isEditing = selectedId === "new" || mode === "edit";
  const detail = selectedId ? (
    isEditing ? (
      <ProjectEditor key={`${selectedId}:${mode || "create"}`} selectedId={selectedId} onSaved={reload} />
    ) : (
      <ProjectDetail key={selectedId} selectedId={selectedId} onChanged={reload} />
    )
  ) : (
    <div class="pane-empty">
      <Icon name="folder" size={28} />
      <h3>Select a project</h3>
      <p>Open a project to edit context, inspect linked tasks, or archive it.</p>
      <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => navigateHash("#/projects/new")}>New project</Button>
    </div>
  );

  return (
    <AppShell route="projects">
      <PaneLayout
        listHeader={listHeader}
        listBody={listBody}
        detail={detail}
        hasSelection={!!selectedId}
        detailOwnsMobileBack={!!selectedId}
        onBack={() => navigateHash("#/projects")}
        backLabel="All projects"
      />
    </AppShell>
  );
}
