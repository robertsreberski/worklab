import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { navigateHash } from "../lib/navigation.js";
import { Button } from "../components/primitives/Button.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { MobilePillRow, MobileTopbar } from "../components/AppShell.jsx";
import { EntityChromeBridge } from "../components/EntityChromeBridge.jsx";
import { Card } from "../components/Card.jsx";
import { EntityBadge } from "../components/EntityBadge.jsx";
import { EntityMetaList } from "../components/EntityMetaList.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { Icon } from "../components/Icon.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { MarkdownContent } from "../components/Markdown.jsx";
import { DetailHead, SectionGroup, SectionMarker, SectionStack } from "../components/layout/index.js";
import { normalizeKbEntry } from "./kb-entry-form.js";
import { taskRouteId } from "../lib/display.js";
import { useAppResume } from "../lib/pageVisibility.js";

const KB_READ_SECTIONS = [
  { id: "kb-read-body", num: "01", label: "Body", meta: "Markdown" },
];

function categoryToken(category) {
  const c = (category || "").toLowerCase();
  if (c.includes("how")) return "howto";
  if (c.includes("policy")) return "policy";
  if (c.includes("ref")) return "reference";
  return c.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || null;
}

function formatDateTime(value) {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function UsageList({ usage }) {
  const tasks = usage?.tasks || [];
  const agents = usage?.agents || [];
  if (!usage) return <p class="soft-meta">Checking references...</p>;
  if (tasks.length === 0 && agents.length === 0) return <p class="soft-meta">No references yet.</p>;

  return (
    <SectionStack class="knowledge-usage-groups">
      {tasks.length > 0 && (
        <SectionGroup class="knowledge-usage-group" label="Tasks" count={`(${tasks.length})`}>
          <ul class="usage-list knowledge-read-usage-list">
            {tasks.map((task) => (
              <li key={task.id}>
                <EntityBadge kind="task" label={task.title} href={`#/tasks/${taskRouteId(task)}`} />{" "}
                <StatusPill status={task.stage || "plan"} size="sm" />
              </li>
            ))}
          </ul>
        </SectionGroup>
      )}
      {agents.length > 0 && (
        <SectionGroup class="knowledge-usage-group" label="Agents" count={`(${agents.length})`}>
          <ul class="usage-list knowledge-read-usage-list">
            {agents.map((agent) => (
              <li key={agent.name}>
                <EntityBadge kind="agent" label={agent.display_name || agent.name} id={agent.name} href={`#/library/agents/${encodeURIComponent(agent.name)}`} />
              </li>
            ))}
          </ul>
        </SectionGroup>
      )}
    </SectionStack>
  );
}

function RelationSlugList({ label, slugs = [] }) {
  const visible = Array.isArray(slugs) ? slugs.filter(Boolean) : [];
  if (!visible.length) return null;
  return (
    <SectionGroup class="knowledge-usage-group" label={label} count={`(${visible.length})`}>
      <ul class="usage-list knowledge-read-usage-list">
        {visible.map((relationSlug) => (
          <li key={relationSlug}>
            <EntityBadge kind="kb" label={relationSlug} href={`#/library/knowledge/${encodeURIComponent(relationSlug)}`} />
          </li>
        ))}
      </ul>
    </SectionGroup>
  );
}

export function KbDetail({ slug }) {
  const [entry, setEntry] = useState(null);
  const [usage, setUsage] = useState(null);
  const [mentions, setMentions] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setUsage(null);

    api.getKb(slug)
      .then((res) => {
        if (cancelled) return;
        setEntry(normalizeKbEntry(res.entry));
        setMentions(res.mentions || null);
      })
      .catch(() => { if (!cancelled) setEntry({ notFound: true }); });
    api.kbUsage(slug)
      .then((res) => { if (!cancelled) setUsage(res); })
      .catch(() => { if (!cancelled) setUsage({ tasks: [], agents: [] }); });

    return () => { cancelled = true; };
  }, [slug]);

  useAppResume(() => {
    api.getKb(slug)
      .then((res) => {
        setEntry(normalizeKbEntry(res.entry));
        setMentions(res.mentions || null);
      })
      .catch(() => setEntry({ notFound: true }));
    api.kbUsage(slug)
      .then((res) => setUsage(res))
      .catch(() => setUsage({ tasks: [], agents: [] }));
  });

  const title = entry?.notFound ? "Entry not found" : (entry?.title || slug);
  const categoryAttr = categoryToken(entry?.category);
  const tagCount = entry?.tags?.length || 0;
  const projectLabel = entry?.project?.name || entry?.project?.slug || (entry?.project_id ? entry.project_id : "Global");
  const sourceTaskLabel = entry?.source_task_key || entry?.source_task_id || "";
  const usageCount = (usage?.tasks?.length || 0) + (usage?.agents?.length || 0);
  const relationCount = (entry?.related_slugs?.length || 0) + (entry?.supersedes_slugs?.length || 0) + (entry?.canonical_slug ? 1 : 0);
  const rail = useMemo(() => {
    if (!entry || entry.notFound) return null;
    return (
      <div class="entity-editor-rail-content knowledge-read-rail-content">
        <Card variant="spacious" title="Context" class="entity-rail-card">
          <EntityMetaList
            items={[
              { label: "Slug", value: slug },
              { label: "Project", value: projectLabel, mono: false },
              { label: "Category", value: entry.category || "Uncategorized", mono: false },
              { label: "Subcategory", value: entry.subcategory || "None", mono: false },
              { label: "Tags", value: tagCount ? entry.tags.join(", ") : "None", mono: false },
              { label: "Source task", value: sourceTaskLabel, mono: false },
              { label: "Source run", value: entry.source_run_id || "", mono: true },
              { label: "Source agent", value: entry.source_agent || "", mono: false },
              { label: "Canonical", value: entry.canonical_slug || "", mono: true },
              { label: "Pinned", value: entry.pinned ? "Yes" : "No", mono: false },
              { label: "Author", value: entry.author || "", mono: false },
              { label: "Created", value: formatDateTime(entry.created_at), mono: false },
              { label: "Updated", value: formatDateTime(entry.updated_at), mono: false },
            ]}
          />
        </Card>
        <Card variant="spacious" title="References" class="entity-rail-card knowledge-read-usage-card">
          <SectionStack class="knowledge-usage-groups">
            {entry.canonical_slug && (
              <RelationSlugList label="Canonical entry" slugs={[entry.canonical_slug]} />
            )}
            <RelationSlugList label="Related entries" slugs={entry.related_slugs} />
            <RelationSlugList label="Supersedes" slugs={entry.supersedes_slugs} />
          </SectionStack>
          <UsageList usage={usage} />
        </Card>
      </div>
    );
  }, [entry, projectLabel, slug, sourceTaskLabel, tagCount, usage]);

  if (!entry) return <LoadingState caption="Loading entry..." />;

  if (entry.notFound) {
    return (
      <>
        <EntityChromeBridge
          chrome={{
            mobileTopbar: <MobileTopbar title={slug} backLabel="Knowledge" onBack={() => navigateHash("#/library/knowledge")} overflow={false} />,
          }}
        />
        <div class="pane-empty">
          <h3>Entry not found</h3>
          <p>This knowledge entry may have been deleted.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <EntityChromeBridge
        chrome={{
          mobileTopbar: <MobileTopbar title={slug} backLabel="Knowledge" onBack={() => navigateHash("#/library/knowledge")} />,
          mobileActionDock: (
            <Button
              variant="primary"
              iconLeft={<Icon name="edit-3" size={13} />}
              onClick={() => navigateHash(`#/library/knowledge/${encodeURIComponent(slug)}/edit`)}
            >
              Edit
            </Button>
          ),
          drawerTitle: "Details",
          drawerKicker: slug,
          drawerContent: rail,
          sections: KB_READ_SECTIONS,
        }}
      />
      <DetailHead
        class="knowledge-detail-head knowledge-read-head"
        backLabel="All entries"
        onBack={() => navigateHash("#/library/knowledge")}
        crumbs={[
          { label: "Knowledge", href: "#/library/knowledge" },
          { label: title },
        ]}
        icon={<Icon name={entry.pinned ? "pin" : "book"} size={16} />}
        iconClass={`knowledge-detail-icon ${entry.pinned ? "pinned" : ""}`.trim()}
        kicker="Knowledge"
        title={title || "(untitled)"}
        meta={(
          <>
            <span class="pane-row-mono">{slug}</span>
            <span class="pane-row-dot">·</span>
            <span>{tagCount} tag{tagCount === 1 ? "" : "s"}</span>
            {entry.project?.slug && (
              <>
                <span class="pane-row-dot">·</span>
                <span>{entry.project.slug}</span>
              </>
            )}
            {usageCount > 0 && (
              <>
                <span class="pane-row-dot">·</span>
                <span>{usageCount} reference{usageCount === 1 ? "" : "s"}</span>
              </>
            )}
            {relationCount > 0 && (
              <>
                <span class="pane-row-dot">·</span>
                <span>{relationCount} linked</span>
              </>
            )}
          </>
        )}
        actions={(
          <>
            {entry.pinned && <Chip variant="accent" leading={<Icon name="pin" size={10} />}>Pinned</Chip>}
            {categoryAttr && <span class="kb-category-badge" data-category={categoryAttr}>{entry.category}</span>}
            {entry.subcategory && <span class="kb-category-badge" data-category={categoryToken(entry.subcategory)}>{entry.subcategory}</span>}
            <Button
              variant="secondary"
              iconLeft={<Icon name="edit-3" size={13} />}
              onClick={() => navigateHash(`#/library/knowledge/${encodeURIComponent(slug)}/edit`)}
            >
              Edit
            </Button>
          </>
        )}
        subBar={<MobilePillRow railLabel="Details" railCount={2} sections={KB_READ_SECTIONS} />}
      />
      <div class="pane-detail-body entity-detail-body knowledge-detail-body knowledge-read-body">
        <div class="knowledge-read-layout">
          <main class="knowledge-read-main">
            <FormSection class="knowledge-read-section" aria-labelledby="kb-read-body">
              <SectionMarker id="kb-read-body" num="01" kicker="Body" meta="Markdown" />
              {entry.body.trim() ? (
                <article class="knowledge-read-article">
                  <MarkdownContent
                    content={entry.body}
                    className="markdown doc-content knowledge-read-markdown"
                    expandable={false}
                    mentions={mentions}
                  />
                </article>
              ) : (
                <div class="task-plan-empty knowledge-read-empty">No content yet. Use edit to add Markdown.</div>
              )}
            </FormSection>
          </main>

          <aside class="entity-editor-rail knowledge-read-rail is-mobile-drawer-source">
            {rail}
          </aside>
        </div>
      </div>
    </>
  );
}
