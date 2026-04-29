import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { navigateHash } from "../lib/navigation.js";
import { Button } from "../components/primitives/Button.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { MobilePillRow, MobileTopbar, useAppChrome } from "../components/AppShell.jsx";
import { Card } from "../components/Card.jsx";
import { EntityMetaList } from "../components/EntityMetaList.jsx";
import { Icon } from "../components/Icon.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { MarkdownContent } from "../components/Markdown.jsx";
import { DetailHead, SectionMarker } from "../components/layout/index.js";
import { normalizeKbEntry } from "./kb-entry-form.js";
import { taskRouteId } from "../lib/display.js";

const KB_READ_SECTIONS = [
  { id: "kb-read-body", num: "01", label: "Body", meta: "Markdown" },
];

function EntityChromeBridge({ chrome }) {
  useAppChrome(chrome, [chrome]);
  return null;
}

function categoryToken(category) {
  const c = (category || "").toLowerCase();
  if (c.includes("how")) return "howto";
  if (c.includes("policy")) return "policy";
  if (c.includes("ref")) return "reference";
  return null;
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
    <div class="knowledge-usage-groups">
      {tasks.length > 0 && (
        <div class="knowledge-usage-group">
          <div class="form-section-kicker">Tasks ({tasks.length})</div>
          <ul class="usage-list knowledge-read-usage-list">
            {tasks.map((task) => (
              <li key={task.id}>
                <a href={`#/tasks/${taskRouteId(task)}`}>{task.title}</a>{" "}
                <StatusPill status={task.stage || "plan"} size="sm" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {agents.length > 0 && (
        <div class="knowledge-usage-group">
          <div class="form-section-kicker">Agents ({agents.length})</div>
          <ul class="usage-list knowledge-read-usage-list">
            {agents.map((agent) => (
              <li key={agent.name}>
                <a href={`#/agents/${agent.name}`}>{agent.display_name || agent.name}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function KbDetail({ slug }) {
  const [entry, setEntry] = useState(null);
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setUsage(null);

    api.getKb(slug)
      .then((res) => { if (!cancelled) setEntry(normalizeKbEntry(res.entry)); })
      .catch(() => { if (!cancelled) setEntry({ notFound: true }); });
    api.kbUsage(slug)
      .then((res) => { if (!cancelled) setUsage(res); })
      .catch(() => { if (!cancelled) setUsage({ tasks: [], agents: [] }); });

    return () => { cancelled = true; };
  }, [slug]);

  const title = entry?.notFound ? "Entry not found" : (entry?.title || slug);
  const categoryAttr = categoryToken(entry?.category);
  const tagCount = entry?.tags?.length || 0;
  const usageCount = (usage?.tasks?.length || 0) + (usage?.agents?.length || 0);
  const rail = useMemo(() => {
    if (!entry || entry.notFound) return null;
    return (
      <div class="entity-editor-rail-content knowledge-read-rail-content">
        <Card variant="spacious" title="Context" class="entity-rail-card">
          <EntityMetaList
            items={[
              { label: "Slug", value: slug },
              { label: "Category", value: entry.category || "Uncategorized", mono: false },
              { label: "Tags", value: tagCount ? entry.tags.join(", ") : "None", mono: false },
              { label: "Pinned", value: entry.pinned ? "Yes" : "No", mono: false },
              { label: "Author", value: entry.author || "", mono: false },
              { label: "Created", value: formatDateTime(entry.created_at), mono: false },
              { label: "Updated", value: formatDateTime(entry.updated_at), mono: false },
            ]}
          />
        </Card>
        <Card variant="spacious" title="References" class="entity-rail-card knowledge-read-usage-card">
          <UsageList usage={usage} />
        </Card>
      </div>
    );
  }, [entry, slug, tagCount, usage]);

  if (!entry) return <LoadingState caption="Loading entry..." />;

  if (entry.notFound) {
    return (
      <>
        <EntityChromeBridge
          chrome={{
            mobileTopbar: <MobileTopbar title={slug} backLabel="Knowledge" onBack={() => navigateHash("#/knowledge")} overflow={false} />,
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
          mobileTopbar: <MobileTopbar title={slug} backLabel="Knowledge" onBack={() => navigateHash("#/knowledge")} />,
          drawerTitle: "Details",
          drawerKicker: slug,
          drawerContent: rail,
          sections: KB_READ_SECTIONS,
        }}
      />
      <DetailHead
        class="knowledge-detail-head knowledge-read-head"
        backLabel="All entries"
        onBack={() => navigateHash("#/knowledge")}
        crumbs={[
          { label: "Knowledge", href: "#/knowledge" },
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
            {usageCount > 0 && (
              <>
                <span class="pane-row-dot">·</span>
                <span>{usageCount} reference{usageCount === 1 ? "" : "s"}</span>
              </>
            )}
          </>
        )}
        actions={(
          <>
            {entry.pinned && <Chip variant="accent" leading={<Icon name="pin" size={10} />}>Pinned</Chip>}
            {categoryAttr && <span class="kb-category-badge" data-category={categoryAttr}>{entry.category}</span>}
            <Button
              variant="secondary"
              iconLeft={<Icon name="edit-3" size={13} />}
              onClick={() => navigateHash(`#/knowledge/${slug}/edit`)}
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
            <section class="knowledge-read-section" aria-labelledby="kb-read-body">
              <SectionMarker id="kb-read-body" num="01" kicker="Body" meta="Markdown" />
              {entry.body.trim() ? (
                <article class="knowledge-read-article">
                  <MarkdownContent
                    content={entry.body}
                    className="markdown doc-content knowledge-read-markdown"
                    expandable={false}
                  />
                </article>
              ) : (
                <div class="task-plan-empty knowledge-read-empty">No content yet. Use edit to add Markdown.</div>
              )}
            </section>
          </main>

          <aside class="entity-editor-rail knowledge-read-rail is-mobile-drawer-source">
            {rail}
          </aside>
        </div>
      </div>
    </>
  );
}
