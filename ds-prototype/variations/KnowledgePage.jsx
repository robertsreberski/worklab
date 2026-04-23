// Knowledge Base page — list of entries + full entry view.
// Left: searchable list grouped by category.
// Right: rendered entry with metadata, body, and reference graph
//   (which tasks & agents use it).

function KbCategoryBadge({ category }) {
  const map = {
    reference: { color: 'var(--accent)', label: 'REF' },
    howto: { color: 'var(--teal)', label: 'HOW-TO' },
    policy: { color: 'var(--yellow)', label: 'POLICY' },
  };
  const m = map[category] || { color: 'var(--muted)', label: category };
  return (
    <span style={{
      padding: '1px 5px', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4,
      background: `color-mix(in oklch, ${m.color} 14%, transparent)`,
      color: m.color,
      border: `1px solid color-mix(in oklch, ${m.color} 35%, transparent)`,
      borderRadius: 3,
    }}>{m.label}</span>
  );
}

function KbRowItem({ e, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', textAlign: 'left',
      background: active ? 'rgba(159,184,255,0.06)' : 'transparent',
      border: 'none', borderBottom: '1px solid var(--border)',
      padding: '10px 14px', cursor: 'pointer',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {e.pinned && (
          <span title="Pinned" style={{
            color: 'var(--yellow)', fontSize: 10, marginRight: 1,
          }}>●</span>
        )}
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {e.title}
        </span>
        <KbCategoryBadge category={e.category} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--muted)' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>{e.slug}</span>
        <span style={{ color: 'var(--muted-2)' }}>·</span>
        <span>Updated {formatAge(e.updatedAt)}</span>
        {e.referenced_by.tasks.length + e.referenced_by.agents.length > 0 && (
          <>
            <span style={{ color: 'var(--muted-2)' }}>·</span>
            <span>{e.referenced_by.tasks.length + e.referenced_by.agents.length} refs</span>
          </>
        )}
      </div>
    </button>
  );
}

function KbList({ selected, onSelect, onNew }) {
  const [q, setQ] = React.useState('');
  const [cat, setCat] = React.useState('all');
  const filtered = KB_ENTRIES.filter(e => {
    if (cat !== 'all' && e.category !== cat) return false;
    if (!q) return true;
    const x = q.toLowerCase();
    return e.title.toLowerCase().includes(x)
        || e.body.toLowerCase().includes(x)
        || e.tags.some(t => t.toLowerCase().includes(x));
  });
  // Pinned first
  const sorted = [...filtered].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderRight: '1px solid var(--border)' }}>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: '12px 14px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface-muted)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '0 10px', height: 28, flex: 1,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6,
          }}>
            <Ic name="search" size={12} color="var(--muted-2)" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search entries, tags…"
              style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 12, outline: 'none' }} />
          </div>
          <button onClick={onNew} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px',
            background: 'var(--accent)', color: 'var(--accent-ink)',
            border: '1px solid var(--accent)', borderRadius: 6,
            fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}>
            <Ic name="plus" size={11} color="var(--accent-ink)" />
            New
          </button>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {[['all', 'All'], ['reference', 'Reference'], ['howto', 'How-to'], ['policy', 'Policy']].map(([v, l]) => (
            <button key={v} onClick={() => setCat(v)} style={{
              padding: '3px 8px', fontSize: 11, fontWeight: 600,
              background: cat === v ? 'var(--accent)' : 'transparent',
              color: cat === v ? 'var(--accent-ink)' : 'var(--muted)',
              border: `1px solid ${cat === v ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 999, cursor: 'pointer',
            }}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }} className="wl-hide-scrollbar">
        {sorted.map(e => (
          <KbRowItem key={e.slug} e={e} active={selected === e.slug} onClick={() => onSelect(e.slug)} />
        ))}
        {sorted.length === 0 && (
          <div style={{ padding: '32px 20px', fontSize: 12, color: 'var(--muted-2)', textAlign: 'center', fontStyle: 'italic' }}>
            No entries match.
          </div>
        )}
      </div>
    </div>
  );
}

// Lightweight markdown-ish rendering — handle bold **, headings #, lists.
function MiniMd({ text }) {
  const lines = text.split('\n');
  const out = [];
  let list = [];
  const flushList = () => {
    if (list.length) {
      out.push(<ul key={`u${out.length}`} style={{
        margin: '6px 0 10px', paddingLeft: 22, fontSize: 13.5,
        color: 'var(--text-soft)', lineHeight: 1.65,
      }}>
        {list.map((item, i) => <li key={i} style={{ marginBottom: 3 }}>{renderInline(item)}</li>)}
      </ul>);
      list = [];
    }
  };
  function renderInline(s) {
    // **bold** and `code`
    const parts = [];
    let i = 0, key = 0;
    const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)/g;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > i) parts.push(s.slice(i, m.index));
      if (m[2]) parts.push(<strong key={key++} style={{ color: 'var(--text)', fontWeight: 700 }}>{m[2]}</strong>);
      if (m[4]) parts.push(<code key={key++} style={{
        fontFamily: 'var(--mono)', fontSize: '0.88em',
        background: 'var(--surface-muted)', padding: '1px 5px',
        border: '1px solid var(--border)', borderRadius: 3, color: 'var(--accent-strong)',
      }}>{m[4]}</code>);
      i = m.index + m[0].length;
    }
    if (i < s.length) parts.push(s.slice(i));
    return parts;
  }
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushList(); continue; }
    if (line.startsWith('# ')) {
      flushList();
      out.push(<h2 key={out.length} style={{ fontSize: 17, fontWeight: 700, margin: '14px 0 6px', letterSpacing: -0.1 }}>{line.slice(2)}</h2>);
    } else if (line.startsWith('## ')) {
      flushList();
      out.push(<h3 key={out.length} style={{ fontSize: 14.5, fontWeight: 700, margin: '12px 0 5px', letterSpacing: -0.1 }}>{line.slice(3)}</h3>);
    } else if (line.startsWith('**') && line.endsWith('**')) {
      flushList();
      out.push(<div key={out.length} style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-soft)', marginTop: 10, marginBottom: 4 }}>{line.slice(2, -2)}</div>);
    } else if (/^[-*]\s/.test(line)) {
      list.push(line.replace(/^[-*]\s/, ''));
    } else if (/^\d+\.\s/.test(line)) {
      list.push(line.replace(/^\d+\.\s/, ''));
    } else {
      flushList();
      out.push(<p key={out.length} style={{ margin: '0 0 8px', fontSize: 13.5, color: 'var(--text-soft)', lineHeight: 1.65 }}>{renderInline(line)}</p>);
    }
  }
  flushList();
  return <>{out}</>;
}

function KbEntryView({ entry }) {
  const [editing, setEditing] = React.useState(false);
  const [body, setBody] = React.useState(entry.body);
  React.useEffect(() => { setBody(entry.body); setEditing(false); }, [entry?.slug]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '14px 22px', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: 'var(--surface-muted)',
          border: '1px solid var(--border-strong)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Ic name="book" size={16} color="var(--muted)" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: -0.2 }}>
              {entry.title}
            </h1>
            {entry.pinned && <span style={{
              padding: '1px 6px', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
              background: 'rgba(255,188,120,0.14)', color: 'var(--yellow)', borderRadius: 3,
            }}>Pinned</span>}
            <KbCategoryBadge category={entry.category} />
          </div>
          <div style={{ marginTop: 3, fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)' }}>{entry.slug}</span>
            <span style={{ color: 'var(--muted-2)' }}>·</span>
            <span>Updated {formatAge(entry.updatedAt)}</span>
            <span style={{ color: 'var(--muted-2)' }}>·</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {entry.tags.map(t => (
                <span key={t} style={{
                  padding: '1px 6px', fontSize: 11,
                  background: 'var(--surface-muted)', color: 'var(--muted)',
                  border: '1px solid var(--border)', borderRadius: 3,
                }}>#{t}</span>
              ))}
            </div>
          </div>
        </div>
        <button onClick={() => setEditing(e => !e)} style={{
          padding: '7px 12px',
          background: editing ? 'var(--accent)' : 'var(--surface-raised)',
          color: editing ? 'var(--accent-ink)' : 'var(--text)',
          border: `1px solid ${editing ? 'var(--accent)' : 'var(--border-strong)'}`,
          borderRadius: 6, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}>{editing ? 'Save' : 'Edit'}</button>
      </div>

      <div style={{
        flex: 1, overflow: 'auto',
        display: 'grid', gridTemplateColumns: '1fr 280px', minHeight: 0,
      }} className="wl-hide-scrollbar">
        <div style={{ padding: '22px 26px', borderRight: '1px solid var(--border)', maxWidth: 820 }}>
          {editing ? (
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={24}
              style={{
                width: '100%', padding: '13px 15px',
                background: 'var(--surface-muted)', color: 'var(--text)',
                border: '1px solid var(--border-strong)', borderRadius: 6,
                fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.6,
                resize: 'vertical', outline: 'none',
              }} />
          ) : (
            <div style={{ color: 'var(--text-soft)' }}>
              <MiniMd text={body} />
            </div>
          )}
        </div>
        <div style={{ padding: '22px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--muted-2)', marginBottom: 8 }}>
              Referenced by · tasks
            </div>
            {entry.referenced_by.tasks.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted-2)', fontStyle: 'italic' }}>No tasks reference this entry.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {entry.referenced_by.tasks.map(id => {
                  const t = taskById[id];
                  if (!t) return null;
                  return (
                    <a key={id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 10px',
                      background: 'var(--surface-muted)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      textDecoration: 'none', cursor: 'pointer',
                    }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusById[t.status].color, flexShrink: 0 }} />
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>{id}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                    </a>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--muted-2)', marginBottom: 8 }}>
              Referenced by · agents
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {entry.referenced_by.agents.map(slug => {
                const a = agentBySlug[slug];
                if (!a) return null;
                return (
                  <span key={slug} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '3px 9px 3px 3px',
                    background: 'var(--surface-muted)',
                    border: '1px solid var(--border)', borderRadius: 999,
                    fontSize: 12, color: 'var(--text-soft)', fontWeight: 600,
                  }}>
                    <AgentAvatar slug={slug} size={18} />
                    {a.name}
                  </span>
                );
              })}
            </div>
          </div>

          <div style={{
            padding: 11, background: 'var(--surface-muted)',
            border: '1px solid var(--border)', borderRadius: 6,
            fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.55,
          }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-soft)', marginBottom: 5 }}>
              How agents find this
            </div>
            Agents retrieve entries by tag, slug (<code style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>#{entry.slug}</code>), or semantic search over the body.
          </div>
        </div>
      </div>
    </div>
  );
}

function KnowledgePage({ initialSlug = 'auth-module-overview' }) {
  const [selected, setSelected] = React.useState(initialSlug);
  const entry = kbBySlug[selected] || KB_ENTRIES[0];

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'grid', gridTemplateRows: 'auto 1fr',
      background: 'var(--bg)', fontFamily: 'var(--sans)', color: 'var(--text)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        padding: '14px 22px 10px', borderBottom: '1px solid var(--border)',
      }}>
        <div>
          <div style={{ color: 'var(--muted-2)', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' }}>
            Worklab · Knowledge base
          </div>
          <h2 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 700, letterSpacing: -0.2 }}>
            {KB_ENTRIES.length} entries · {KB_ENTRIES.filter(e => e.pinned).length} pinned
          </h2>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Shared context all agents can read. Tag with <code style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-soft)' }}>#slug</code> to reference from a task or instructions.
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', minHeight: 0 }}>
        <KbList selected={selected} onSelect={setSelected} onNew={() => {}} />
        <KbEntryView entry={entry} />
      </div>
    </div>
  );
}

window.KnowledgePage = KnowledgePage;
