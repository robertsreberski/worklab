// Agents page — registry of configured agents.
// Left column: dense list of agents with live-run state, runs/30d, avg duration.
// Right column: selected agent detail/editor (display name, description, SDK + model,
//   effort, instructions, skills allowlist, MCP/builtin allowlist, enable toggle).

function AgentStatusDot({ enabled, lastRunAt }) {
  if (!enabled) return <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--muted-2)' }} />;
  const recent = Date.now() - lastRunAt < 1000 * 60 * 5;
  if (recent) return <LivePulse color="var(--green)" size={6} />;
  return <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', opacity: 0.55 }} />;
}

function AgentRowItem({ a, active, onClick }) {
  const core = agentBySlug[a.slug];
  return (
    <button onClick={onClick} style={{
      width: '100%', textAlign: 'left', background: active ? 'rgba(159,184,255,0.06)' : 'transparent',
      border: 'none', borderBottom: '1px solid var(--border)',
      padding: '10px 14px', cursor: 'pointer',
      display: 'grid', gridTemplateColumns: '26px 1fr 64px 78px', gap: 10, alignItems: 'center',
    }}>
      <AgentAvatar slug={a.slug} size={26} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{a.display_name}</span>
          {!a.enabled && <span style={{ padding: '1px 5px', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', background: 'var(--surface-muted)', color: 'var(--muted-2)', border: '1px solid var(--border)', borderRadius: 3 }}>Paused</span>}
          {core?.role === 'reviewer' && <span style={{ padding: '1px 5px', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', background: 'rgba(198,166,255,0.14)', color: 'var(--purple)', borderRadius: 3 }}>Reviewer</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ fontFamily: 'var(--mono)' }}>{a.model_id}</span> · {a.effort} effort
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
        <AgentStatusDot enabled={a.enabled} lastRunAt={a.lastRunAt} />
        {a.runsLast30}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right', fontFamily: 'var(--mono)' }}>
        {formatDuration(a.avgDurationMs)}
      </div>
    </button>
  );
}

function AgentList({ selected, onSelect, onNew }) {
  const [q, setQ] = React.useState('');
  const filtered = AGENTS_EX.filter(a => {
    if (!q) return true;
    const s = q.toLowerCase();
    return a.display_name.toLowerCase().includes(s)
        || a.description.toLowerCase().includes(s)
        || a.model_id.toLowerCase().includes(s);
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
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 6,
        }}>
          <Ic name="search" size={12} color="var(--muted-2)" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search agents…"
            style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 12, outline: 'none' }}
          />
        </div>
        <button onClick={onNew} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 28, padding: '0 10px',
          background: 'var(--accent)', color: 'var(--accent-ink)',
          border: '1px solid var(--accent)', borderRadius: 6,
          fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}>
          <Ic name="plus" size={11} color="var(--accent-ink)" />
          New
        </button>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: '26px 1fr 64px 78px', gap: 10,
        padding: '8px 14px', background: 'var(--surface-muted)',
        borderBottom: '1px solid var(--border)',
        fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
        color: 'var(--muted-2)',
      }}>
        <span />
        <span>Agent</span>
        <span>Runs</span>
        <span style={{ textAlign: 'right' }}>Avg</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }} className="wl-hide-scrollbar">
        {filtered.map(a => (
          <AgentRowItem key={a.slug} a={a} active={selected === a.slug} onClick={() => onSelect(a.slug)} />
        ))}
      </div>
    </div>
  );
}

function Row({ label, hint, children, wide }) {
  return (
    <div style={{ gridColumn: wide ? '1 / -1' : 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-soft)' }}>{label}</label>
        {hint && <span style={{ fontSize: 10.5, color: 'var(--muted-2)', fontFamily: 'var(--mono)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Pill({ children, active, onToggle, color = 'var(--accent)' }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 9px',
        background: active ? `color-mix(in oklch, ${color} 14%, transparent)` : 'var(--surface-muted)',
        color: active ? color : 'var(--text-soft)',
        border: `1px solid ${active ? `color-mix(in oklch, ${color} 45%, transparent)` : 'var(--border)'}`,
        borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
      }}>
      {children}
    </button>
  );
}

function AgentEditor({ agent }) {
  const [a, setA] = React.useState(agent);
  React.useEffect(() => setA(agent), [agent?.slug]);
  function patch(p) { setA(prev => ({ ...prev, ...p })); }

  // All available skills from the catalog
  const allSkills = SKILLS.map(s => s.name);
  const toggleSkill = (name) => patch({
    skills_allowlist: a.skills_allowlist.includes(name)
      ? a.skills_allowlist.filter(x => x !== name)
      : [...a.skills_allowlist, name],
  });

  const mcpCatalog = ['github', 'linear', 'slack', 'pagerduty', 'sentry', 'datadog'];
  const builtinCatalog = ['Read', 'Write', 'Edit', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

  const toggleMcp = (name) => patch({
    mcp_allowlist: a.mcp_allowlist.includes(name)
      ? a.mcp_allowlist.filter(x => x !== name)
      : [...a.mcp_allowlist, name],
  });
  const toggleBuiltin = (name) => patch({
    builtin_allowlist: a.builtin_allowlist.includes(name)
      ? a.builtin_allowlist.filter(x => x !== name)
      : [...a.builtin_allowlist, name],
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '14px 22px', borderBottom: '1px solid var(--border)',
      }}>
        <AgentAvatar slug={a.slug} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              value={a.display_name}
              onChange={e => patch({ display_name: e.target.value })}
              style={{
                background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--text)', fontSize: 20, fontWeight: 700, letterSpacing: -0.2,
                padding: 0, width: 260,
              }}
            />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)', padding: '2px 6px', background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 3 }}>
              {a.slug}
            </span>
          </div>
          <div style={{ marginTop: 3, fontSize: 12, color: 'var(--muted)' }}>
            Last run <span style={{ color: 'var(--text-soft)' }}>{formatAge(a.lastRunAt)}</span>
            <span style={{ color: 'var(--muted-2)' }}> · </span>
            <span style={{ color: 'var(--text-soft)', fontFamily: 'var(--mono)' }}>{a.runsLast30}</span> runs in 30d
            <span style={{ color: 'var(--muted-2)' }}> · </span>
            avg <span style={{ color: 'var(--text-soft)', fontFamily: 'var(--mono)' }}>{formatDuration(a.avgDurationMs)}</span>
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <span style={{ fontSize: 12, color: a.enabled ? 'var(--green)' : 'var(--muted)' }}>{a.enabled ? 'Enabled' : 'Paused'}</span>
          <div onClick={() => patch({ enabled: !a.enabled })} style={{
            width: 36, height: 20, borderRadius: 999, padding: 2,
            background: a.enabled ? 'var(--green)' : 'var(--surface)',
            border: '1px solid var(--border-strong)',
            display: 'flex', justifyContent: a.enabled ? 'flex-end' : 'flex-start',
            transition: 'all .15s', cursor: 'pointer',
          }}>
            <span style={{ width: 14, height: 14, borderRadius: '50%', background: a.enabled ? 'var(--accent-ink)' : 'var(--muted)' }} />
          </div>
        </label>
        <button style={{
          padding: '7px 12px', background: 'var(--accent)', color: 'var(--accent-ink)',
          border: '1px solid var(--accent)', borderRadius: 6,
          fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}>Save changes</button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px' }} className="wl-hide-scrollbar">
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, rowGap: 22,
          maxWidth: 880,
        }}>
          <Row label="Description" hint="shown to humans" wide>
            <textarea
              value={a.description}
              onChange={e => patch({ description: e.target.value })}
              rows={2}
              style={{
                width: '100%', padding: '9px 11px',
                background: 'var(--surface-muted)', color: 'var(--text)',
                border: '1px solid var(--border-strong)', borderRadius: 6,
                fontSize: 13, fontFamily: 'var(--sans)', lineHeight: 1.5,
                resize: 'vertical', outline: 'none',
              }}
            />
          </Row>

          <Row label="SDK">
            <div style={{ display: 'flex', gap: 5 }}>
              {['claude', 'openai', 'local'].map(s => (
                <Pill key={s} active={a.sdk === s} onToggle={() => patch({ sdk: s })}>
                  {s}
                </Pill>
              ))}
            </div>
          </Row>

          <Row label="Effort" hint="reasoning depth">
            <div style={{ display: 'flex', gap: 5 }}>
              {['low', 'medium', 'high', 'xhigh'].map(e => (
                <Pill key={e} active={a.effort === e} onToggle={() => patch({ effort: e })}>
                  {e}
                </Pill>
              ))}
            </div>
          </Row>

          <Row label="Model" hint="full model id" wide>
            <input
              value={a.model_id}
              onChange={e => patch({ model_id: e.target.value })}
              style={{
                width: '100%', padding: '9px 11px',
                background: 'var(--surface-muted)', color: 'var(--text)',
                border: '1px solid var(--border-strong)', borderRadius: 6,
                fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 500,
                outline: 'none',
              }}
            />
          </Row>

          <Row label="Instructions" hint="system prompt · markdown" wide>
            <textarea
              value={a.instructions}
              onChange={e => patch({ instructions: e.target.value })}
              rows={9}
              style={{
                width: '100%', padding: '11px 13px',
                background: 'var(--surface-muted)', color: 'var(--text)',
                border: '1px solid var(--border-strong)', borderRadius: 6,
                fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6,
                resize: 'vertical', outline: 'none',
              }}
            />
          </Row>

          <Row label="Skills" hint={a.skills_allowlist.length === 0 ? 'open · inherits all' : `${a.skills_allowlist.length} allowed`} wide>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {allSkills.map(name => (
                <Pill key={name} active={a.skills_allowlist.includes(name)} onToggle={() => toggleSkill(name)}>
                  {skillByName[name]?.display_name || name}
                </Pill>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
              If empty, this agent inherits all enabled skills in the catalog.
            </div>
          </Row>

          <Row label="MCP servers" hint="external tools" wide>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {mcpCatalog.map(name => (
                <Pill key={name} active={a.mcp_allowlist.includes(name)} onToggle={() => toggleMcp(name)} color="var(--teal)">
                  {name}
                </Pill>
              ))}
            </div>
          </Row>

          <Row label="Built-in tools" hint="filesystem + shell" wide>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {builtinCatalog.map(name => (
                <Pill key={name} active={a.builtin_allowlist.includes(name)} onToggle={() => toggleBuiltin(name)} color="var(--yellow)">
                  {name}
                </Pill>
              ))}
            </div>
          </Row>
        </div>

        {/* Recent runs */}
        <div style={{ marginTop: 32, maxWidth: 880 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-soft)' }}>
              Recent runs
            </h3>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            <a style={{ fontSize: 11, color: 'var(--accent)', cursor: 'pointer' }}>view all →</a>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            {TASKS.filter(t => t.executor === a.slug || t.reviewer === a.slug).slice(0, 5).map((t, i) => (
              <div key={t.id} style={{
                display: 'grid', gridTemplateColumns: '14px 62px 1fr 70px 80px 70px',
                alignItems: 'center', gap: 10,
                padding: '8px 12px',
                borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                fontSize: 12,
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusById[t.status].color }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>{t.id}</span>
                <span style={{ color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>{formatDuration(t.runDurationMs)}</span>
                <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>{formatCost(t.costUsd)}</span>
                <span style={{ color: 'var(--muted-2)', fontSize: 10.5, textAlign: 'right' }}>{formatAge(t.updatedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentsPage({ initialSlug = 'atlas' }) {
  const [selected, setSelected] = React.useState(initialSlug);
  const agent = agentExBySlug[selected] || AGENTS_EX[0];

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
            Worklab · Agents
          </div>
          <h2 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 700, letterSpacing: -0.2 }}>
            {AGENTS_EX.length} agents · {AGENTS_EX.filter(a => a.enabled).length} enabled
          </h2>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Today: <span style={{ color: 'var(--text-soft)', fontFamily: 'var(--mono)' }}>
            {AGENTS_EX.reduce((s, a) => s + Math.round(a.runsLast30 / 30), 0)}
          </span> runs · <span style={{ color: 'var(--text-soft)', fontFamily: 'var(--mono)' }}>$6.05</span> spent
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', minHeight: 0 }}>
        <AgentList selected={selected} onSelect={setSelected} onNew={() => {}} />
        <AgentEditor agent={agent} />
      </div>
    </div>
  );
}

window.AgentsPage = AgentsPage;
