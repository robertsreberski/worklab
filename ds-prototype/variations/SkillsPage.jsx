// Skills page — list of playbook skills + editor.
// Left: list of skills with trigger, priority, used-by count, enabled dot.
// Right: editor — name, trigger, priority (always/when-matched), body (markdown),
//   used-by chips, enable toggle.

function SkillRowItem({ s, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', textAlign: 'left', background: active ? 'rgba(159,184,255,0.06)' : 'transparent',
      border: 'none', borderBottom: '1px solid var(--border)',
      padding: '10px 14px', cursor: 'pointer',
      display: 'grid', gridTemplateColumns: '10px 1fr 46px', gap: 10, alignItems: 'center',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%',
        background: s.enabled ? 'var(--green)' : 'var(--muted-2)', opacity: s.enabled ? 1 : 0.6 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{s.display_name}</span>
          {s.priority === 'always' && <span style={{ padding: '1px 5px', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', background: 'rgba(255,188,120,0.14)', color: 'var(--yellow)', borderRadius: 3 }}>always</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.trigger}
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right', fontFamily: 'var(--mono)' }}>
        {s.used_by.length}
      </div>
    </button>
  );
}

function SkillList({ selected, onSelect, onNew }) {
  const [q, setQ] = React.useState('');
  const filtered = SKILLS.filter(s => {
    if (!q) return true;
    const x = q.toLowerCase();
    return s.display_name.toLowerCase().includes(x)
        || s.trigger.toLowerCase().includes(x)
        || s.name.toLowerCase().includes(x);
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderRight: '1px solid var(--border)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 14px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface-muted)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '0 10px', height: 28, flex: 1,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6,
        }}>
          <Ic name="search" size={12} color="var(--muted-2)" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search skills…"
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
      <div style={{
        display: 'grid', gridTemplateColumns: '10px 1fr 46px', gap: 10,
        padding: '8px 14px', background: 'var(--surface-muted)', borderBottom: '1px solid var(--border)',
        fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--muted-2)',
      }}>
        <span />
        <span>Skill · trigger</span>
        <span style={{ textAlign: 'right' }}>Used</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }} className="wl-hide-scrollbar">
        {filtered.map(s => (
          <SkillRowItem key={s.name} s={s} active={selected === s.name} onClick={() => onSelect(s.name)} />
        ))}
      </div>
    </div>
  );
}

function SkillEditor({ skill }) {
  const [s, setS] = React.useState(skill);
  React.useEffect(() => setS(skill), [skill?.name]);
  function patch(p) { setS(prev => ({ ...prev, ...p })); }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '14px 22px', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: 'rgba(255,188,120,0.12)', color: 'var(--yellow)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '1px solid rgba(255,188,120,0.3)',
        }}>
          <Ic name="spark" size={16} color="var(--yellow)" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input value={s.display_name} onChange={e => patch({ display_name: e.target.value })}
              style={{
                background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--text)', fontSize: 20, fontWeight: 700, letterSpacing: -0.2,
                padding: 0, width: 340,
              }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)', padding: '2px 6px', background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 3 }}>
              {s.name}
            </span>
          </div>
          <div style={{ marginTop: 3, fontSize: 12, color: 'var(--muted)' }}>
            Used by <span style={{ color: 'var(--text-soft)', fontFamily: 'var(--mono)' }}>{s.used_by.length}</span> {s.used_by.length === 1 ? 'agent' : 'agents'}
            <span style={{ color: 'var(--muted-2)' }}> · </span>
            Updated <span style={{ color: 'var(--text-soft)' }}>{formatAge(s.updatedAt)}</span>
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <span style={{ fontSize: 12, color: s.enabled ? 'var(--green)' : 'var(--muted)' }}>{s.enabled ? 'Enabled' : 'Draft'}</span>
          <div onClick={() => patch({ enabled: !s.enabled })} style={{
            width: 36, height: 20, borderRadius: 999, padding: 2,
            background: s.enabled ? 'var(--green)' : 'var(--surface)',
            border: '1px solid var(--border-strong)',
            display: 'flex', justifyContent: s.enabled ? 'flex-end' : 'flex-start',
            transition: 'all .15s', cursor: 'pointer',
          }}>
            <span style={{ width: 14, height: 14, borderRadius: '50%', background: s.enabled ? 'var(--accent-ink)' : 'var(--muted)' }} />
          </div>
        </label>
        <button style={{
          padding: '7px 12px', background: 'var(--accent)', color: 'var(--accent-ink)',
          border: '1px solid var(--accent)', borderRadius: 6,
          fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}>Save</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px' }} className="wl-hide-scrollbar">
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, rowGap: 22,
          maxWidth: 880,
        }}>
          <Row label="Trigger" hint="when to apply" wide>
            <input value={s.trigger} onChange={e => patch({ trigger: e.target.value })}
              style={{
                width: '100%', padding: '9px 11px',
                background: 'var(--surface-muted)', color: 'var(--text)',
                border: '1px solid var(--border-strong)', borderRadius: 6,
                fontSize: 13, outline: 'none',
              }} />
          </Row>

          <Row label="Priority">
            <div style={{ display: 'flex', gap: 5 }}>
              {[['always', 'Always apply'], ['', 'Only when matched']].map(([v, l]) => (
                <Pill key={v || 'matched'} active={s.priority === v} onToggle={() => patch({ priority: v })} color="var(--yellow)">
                  {l}
                </Pill>
              ))}
            </div>
          </Row>

          <Row label="Category">
            <div style={{ display: 'flex', gap: 5 }}>
              {['engineering', 'review', 'ops', 'docs'].map(c => (
                <Pill key={c} active={s.category === c} onToggle={() => patch({ category: c })} color="var(--teal)">
                  {c}
                </Pill>
              ))}
            </div>
          </Row>

          <Row label="Body" hint="markdown · shown to the agent when triggered" wide>
            <textarea value={s.body} onChange={e => patch({ body: e.target.value })} rows={12}
              style={{
                width: '100%', padding: '11px 13px',
                background: 'var(--surface-muted)', color: 'var(--text)',
                border: '1px solid var(--border-strong)', borderRadius: 6,
                fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6,
                resize: 'vertical', outline: 'none',
              }} />
          </Row>

          <Row label="Used by" hint={`${s.used_by.length} agents`} wide>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {s.used_by.length === 0 && (
                <span style={{ fontSize: 12, color: 'var(--muted-2)', fontStyle: 'italic' }}>
                  No agents reference this skill yet.
                </span>
              )}
              {s.used_by.map(slug => {
                const a = agentBySlug[slug];
                if (!a) return null;
                return (
                  <span key={slug} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 9px 4px 4px',
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
          </Row>
        </div>
      </div>
    </div>
  );
}

function SkillsPage({ initialName = 'repro-first' }) {
  const [selected, setSelected] = React.useState(initialName);
  const skill = skillByName[selected] || SKILLS[0];
  const enabled = SKILLS.filter(s => s.enabled).length;
  const always = SKILLS.filter(s => s.priority === 'always').length;

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
            Worklab · Skills
          </div>
          <h2 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 700, letterSpacing: -0.2 }}>
            {SKILLS.length} skills · {enabled} enabled · {always} always-on
          </h2>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Skills are reusable playbooks. Agents inherit the enabled set unless they carry an explicit allowlist.
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', minHeight: 0 }}>
        <SkillList selected={selected} onSelect={setSelected} onNew={() => {}} />
        <SkillEditor skill={skill} />
      </div>
    </div>
  );
}

window.SkillsPage = SkillsPage;
