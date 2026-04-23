// TaskDetail page — designed for Variation A (Commander) aesthetic.
// Full-page detail. Left: brief, activity feed, comments.
// Right: agents + current run stats + dependencies + related.

function Breadcrumb({ onBack, taskId }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '10px 20px', borderBottom: '1px solid var(--border)',
      fontSize: 12,
    }}>
      <button onClick={onBack} style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: 'transparent', border: 'none', color: 'var(--muted)',
        fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0,
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        All tasks
      </button>
      <span style={{ color: 'var(--muted-2)' }}>/</span>
      <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)', fontWeight: 500 }}>{taskId}</span>
    </div>
  );
}

function TaskHero({ task }) {
  const isRunning = task.status === 'in_progress' || task.status === 'in_review';
  const canRun = !isRunning && task.executor && task.status !== 'done';
  return (
    <div style={{ padding: '18px 20px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <StatusPill status={task.status} />
        {isRunning && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 12 }}>
            <LivePulse color={statusById[task.status].color} size={6} />
            {task.currentStep}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <h1 style={{
          margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: -0.3,
          lineHeight: 1.25, maxWidth: '60ch',
        }}>{task.title}</h1>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button disabled={!canRun} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 12px',
            background: canRun ? 'var(--accent)' : 'var(--surface-muted)',
            color: canRun ? 'var(--accent-ink)' : 'var(--muted-2)',
            border: `1px solid ${canRun ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 6, fontSize: 12.5, fontWeight: 700,
            cursor: canRun ? 'pointer' : 'not-allowed',
          }}>
            <Ic name="zap" size={12} color={canRun ? 'var(--accent-ink)' : 'var(--muted-2)'} />
            Run now
          </button>
          {isRunning && (
            <button style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 12px',
              background: 'transparent', color: 'var(--red)',
              border: '1px solid rgba(255,116,126,0.3)', borderRadius: 6,
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            }}>
              <Ic name="hand" size={11} color="var(--red)" />
              Cancel run
            </button>
          )}
          <button style={{
            padding: '7px 12px',
            background: 'var(--surface-raised)', color: 'var(--text)',
            border: '1px solid var(--border-strong)', borderRadius: 6,
            fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
          }}>Edit</button>
          <button style={{
            width: 32, padding: 0, height: 32,
            background: 'var(--surface-raised)', color: 'var(--muted)',
            border: '1px solid var(--border-strong)', borderRadius: 6,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="5" cy="12" r="1.5" fill="currentColor"/>
              <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
              <circle cx="19" cy="12" r="1.5" fill="currentColor"/>
            </svg>
          </button>
        </div>
      </div>
      <TaskInstructions task={task} />
    </div>
  );
}

function TaskInstructions({ task }) {
  if (!task.description) return null;
  return (
    <div style={{
      marginTop: 14,
      padding: '12px 14px',
      background: 'var(--surface-muted)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      maxWidth: '72ch',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
        color: 'var(--muted-2)', marginBottom: 8,
      }}>
        <Ic name="terminal" size={10} color="var(--muted-2)" />
        Instructions to agent
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.6,
        color: 'var(--text-soft)', whiteSpace: 'pre-wrap',
      }}>
        {task.description}
      </div>
    </div>
  );
}

function LiveRunPanel({ task }) {
  const isRunning = task.status === 'in_progress' || task.status === 'in_review';
  const events = task.liveEvents || [];
  const [cursor, setCursor] = React.useState(events.length);

  React.useEffect(() => {
    if (!isRunning || events.length === 0) return;
    setCursor(1);
    const id = setInterval(() => setCursor(c => Math.min(c + 1, events.length)), 1500);
    return () => clearInterval(id);
  }, [task.id, isRunning, events.length]);

  if (!isRunning && events.length === 0) return null;

  const visible = events.slice(0, cursor);

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'rgba(21, 21, 24, 0.5)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface-muted)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isRunning && <LivePulse color="var(--yellow)" size={7} />}
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: 'var(--text)' }}>
            {isRunning ? 'Live run' : 'Latest run'}
          </span>
          {task.executor && <span style={{ color: 'var(--muted)', fontSize: 11 }}>
            · {agentBySlug[task.executor]?.name}
          </span>}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          <span>{formatDuration(task.runDurationMs)}</span>
          <span>{task.turns}t</span>
          <span>{formatTokens(task.tokensIn + task.tokensOut)}</span>
          <span>{formatCost(task.costUsd)}</span>
        </div>
      </div>
      <div style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visible.map((e, i) => (
            <div key={`${task.id}-${i}`} style={{
              animation: i === visible.length - 1 ? 'wl-tick-in .3s both' : 'none',
              display: 'grid', gridTemplateColumns: '48px 1fr', gap: 12, alignItems: 'baseline',
              fontSize: 12,
            }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted-2)', textAlign: 'right' }}>
                {e.t >= 0 ? '+' : ''}{e.t}s
              </span>
              <ToolToken event={e} />
            </div>
          ))}
          {isRunning && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 60, color: 'var(--muted)', fontSize: 11 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, animation: 'wl-caret 1s infinite' }}>▊</span>
              <span style={{ fontStyle: 'italic' }}>streaming…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityFeed({ activity, task }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {activity.map((a, i) => {
        const isLast = i === activity.length - 1;
        return (
          <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '28px 1fr', gap: 14, position: 'relative' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6 }}>
              <ActivityDot entry={a} />
              {!isLast && <div style={{ flex: 1, width: 1, background: 'var(--border)', marginTop: 4 }} />}
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 14 }}>
              <ActivityEntry a={a} task={task} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityDot({ entry }) {
  const base = {
    width: 20, height: 20, borderRadius: '50%',
    border: '2px solid var(--bg)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 10, fontWeight: 700,
  };
  if (entry.kind === 'run') {
    return <div style={{ ...base, padding: 0, background: 'transparent', border: 'none' }}>
      <AgentAvatar slug={entry.agent} size={20} />
    </div>;
  }
  if (entry.kind === 'handoff') {
    return <div style={{ ...base, background: 'rgba(159,184,255,0.14)', color: 'var(--accent)' }}>
      <Ic name="arrow-right" size={11} color="var(--accent)" />
    </div>;
  }
  if (entry.kind === 'comment') {
    if (entry.authorKind === 'agent') {
      return <div style={{ ...base, padding: 0, background: 'transparent', border: 'none' }}>
        <AgentAvatar slug={entry.author} size={20} />
      </div>;
    }
    return <div style={{ ...base, background: 'var(--surface-raised)', color: 'var(--text-soft)', border: '1px solid var(--border-strong)' }}>@</div>;
  }
  if (entry.kind === 'human') {
    return <div style={{ ...base, background: 'var(--surface-raised)', color: 'var(--text-soft)', border: '1px solid var(--border-strong)' }}>@</div>;
  }
  return <div style={{ ...base, background: 'var(--surface-muted)', color: 'var(--muted)', border: '1px solid var(--border)' }}>•</div>;
}

function RunEntry({ a, task }) {
  const [open, setOpen] = React.useState(a.status === 'running');
  const running = a.status === 'running';
  const agent = agentBySlug[a.agent];
  return (
    <div style={{
      border: `1px solid ${running ? 'color-mix(in oklch, var(--yellow) 40%, transparent)' : 'var(--border)'}`,
      borderRadius: 7, overflow: 'hidden',
      background: running ? 'rgba(229,195,107,0.04)' : 'rgba(255,255,255,0.015)',
    }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10, alignItems: 'center',
        padding: '9px 12px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
      }}>
        <div style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform .15s', display: 'flex' }}>
          <Ic name="chevron-right" size={12} color="var(--muted)" />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            {running && <LivePulse color="var(--yellow)" size={6} />}
            <span>{running ? 'Live run' : 'Run'}</span>
            <span style={{ color: 'var(--muted-2)' }}>·</span>
            <span style={{ color: 'var(--muted)', fontWeight: 500 }}>{agent?.name}</span>
            {a.role === 'reviewer' && <span style={{ padding: '1px 6px', background: 'rgba(198,166,255,0.14)', color: 'var(--purple)', borderRadius: 3, fontSize: 10, fontWeight: 700 }}>REVIEW</span>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.summary}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
          <span>{running ? 'running' : formatDuration(a.durationMs)}</span>
          <span>{a.turns}t</span>
          <span>{formatTokens((a.tokensIn || 0) + (a.tokensOut || 0))}</span>
          <span>{formatCost(a.costUsd)}</span>
        </div>
        <span style={{ fontSize: 10.5, color: 'var(--muted-2)', fontFamily: 'var(--mono)' }}>{formatAge(a.t)}</span>
      </button>
      {open && (
        <div style={{ padding: '4px 12px 12px 32px', borderTop: '1px solid var(--border)' }}>
          {a.steps.map((s, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '44px 1fr', gap: 10, alignItems: 'baseline',
              padding: '6px 0', borderTop: i > 0 ? '1px dashed var(--border)' : 'none',
            }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted-2)', textAlign: 'right' }}>
                {formatTime(s.t)}
              </span>
              <div>
                {s.kind === 'agent_think' ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--purple)' }}>✦</span>
                    <span style={{ color: 'var(--text-soft)', fontStyle: 'italic', fontSize: 12.5, lineHeight: 1.5 }}>{s.text}</span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{s.tool}</span>
                    <span style={{ color: 'var(--text-soft)' }}>{s.arg}</span>
                    {s.result && <span style={{ color: s.result.includes('running') ? 'var(--yellow)' : 'var(--green)' }}>→ {s.result}</span>}
                  </div>
                )}
              </div>
            </div>
          ))}
          {running && (
            <div style={{ paddingLeft: 54, color: 'var(--muted)', fontSize: 11, display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={{ animation: 'wl-caret 1s infinite', fontFamily: 'var(--mono)' }}>▊</span>
              <span style={{ fontStyle: 'italic' }}>streaming…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityEntry({ a, task }) {
  const meta = (
    <span style={{ color: 'var(--muted-2)', fontSize: 11, marginLeft: 8 }}>
      {formatAge(a.t)}
    </span>
  );
  if (a.kind === 'run') return <RunEntry a={a} task={task} />;
  if (a.kind === 'handoff') {
    return (
      <div style={{
        padding: '8px 12px',
        background: 'rgba(159,184,255,0.06)',
        border: '1px solid rgba(159,184,255,0.2)',
        borderRadius: 6,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <AgentAvatar slug={a.from} size={18} />
        <span style={{ color: 'var(--text-soft)', fontSize: 12.5, fontWeight: 600 }}>{agentBySlug[a.from]?.name}</span>
        <Ic name="arrow-right" size={11} color="var(--accent)" />
        <AgentAvatar slug={a.to} size={18} />
        <span style={{ color: 'var(--text-soft)', fontSize: 12.5, fontWeight: 600 }}>{agentBySlug[a.to]?.name}</span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>· {a.text}</span>
        {meta}
      </div>
    );
  }
  if (a.kind === 'comment') {
    const isAgent = a.authorKind === 'agent';
    const ag = isAgent ? agentBySlug[a.author] : null;
    return (
      <div style={{
        padding: '9px 12px',
        background: isAgent ? 'rgba(159,184,255,0.04)' : 'var(--surface-raised)',
        border: `1px solid ${isAgent ? 'rgba(159,184,255,0.18)' : 'var(--border)'}`,
        borderRadius: 6,
      }}>
        <div style={{ fontSize: 11, color: 'var(--text-soft)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
          {isAgent ? (
            <>
              <span style={{ color: 'var(--text)' }}>{ag?.name}</span>
              <span style={{
                padding: '1px 6px', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
                background: 'rgba(159,184,255,0.12)', color: 'var(--accent)', borderRadius: 3,
              }}>Agent · post-run</span>
            </>
          ) : (
            <span>@{a.author}</span>
          )}
          {meta}
        </div>
        <div style={{ color: 'var(--text)', fontSize: 13, marginTop: 4, lineHeight: 1.55 }}
             dangerouslySetInnerHTML={{ __html: renderSimpleMd(a.text) }} />
      </div>
    );
  }
  return (
    <div style={{ color: 'var(--muted)', fontSize: 12 }}>{a.text}{meta}</div>
  );
}

function Section({ title, count, action, children, tight }) {
  return (
    <section style={{ marginBottom: tight ? 18 : 24 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 10,
      }}>
        <h3 style={{
          margin: 0, fontSize: 11.5, fontWeight: 700,
          letterSpacing: 0.6, textTransform: 'uppercase',
          color: 'var(--text-soft)',
        }}>{title}</h3>
        {count != null && <span style={{ color: 'var(--muted-2)', fontSize: 11, fontWeight: 600 }}>{count}</span>}
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        {action}
      </div>
      {children}
    </section>
  );
}

function SidePanel({ task }) {
  const deps = (task.dependsOn || []).map(id => taskById[id]).filter(Boolean);
  return (
    <aside style={{
      padding: '18px 20px',
      borderLeft: '1px solid var(--border)',
      background: 'rgba(13,15,20,0.4)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <Section title="Agents" tight>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <AgentRow role="Executor" slug={task.executor} />
          <AgentRow role="Reviewer" slug={task.reviewer} />
        </div>
      </Section>

      <Section title="Dependencies" count={deps.length} tight>
        {deps.length === 0 ? (
          <div style={{ color: 'var(--muted-2)', fontSize: 12, fontStyle: 'italic' }}>None</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {deps.map(d => (
              <a key={d.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px',
                background: 'var(--surface-muted)',
                border: '1px solid var(--border)',
                borderRadius: 6, textDecoration: 'none',
                cursor: 'pointer',
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: statusById[d.status].color,
                }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>{d.id}</span>
                <span style={{ fontSize: 12.5, color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
              </a>
            ))}
          </div>
        )}
      </Section>

      <Section title="Metrics" tight>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {[
            ['Turns', task.turns || '—'],
            ['Duration', formatDuration(task.runDurationMs)],
            ['Input', formatTokens(task.tokensIn)],
            ['Output', formatTokens(task.tokensOut)],
            ['Cost', formatCost(task.costUsd)],
            ['Retries', task.retries || 0],
          ].map(([l, v]) => (
            <div key={l} style={{ padding: '9px 11px', background: 'var(--bg)' }}>
              <div style={{ color: 'var(--muted-2)', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>{l}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)', fontWeight: 600, marginTop: 2 }}>{v}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Timestamps" tight>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
          {[
            ['Created', 'Oct 14, 10:02'],
            ['Last run', formatAge(task.updatedAt)],
            ['Updated', formatAge(task.updatedAt)],
          ].map(([l, v]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--muted)' }}>{l}</span>
              <span style={{ color: 'var(--text-soft)', fontFamily: 'var(--mono)', fontSize: 11.5 }}>{v}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Actions" tight>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[
            ['Duplicate task', 'duplicate'],
            ['Reassign executor', 'reassign'],
            ['Archive', 'archive'],
            ['Delete', 'danger'],
          ].map(([l, kind]) => (
            <button key={l} style={{
              padding: '7px 10px', textAlign: 'left',
              background: 'transparent',
              color: kind === 'danger' ? 'var(--red)' : 'var(--text-soft)',
              border: '1px solid var(--border)', borderRadius: 6,
              fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
            }}>{l}</button>
          ))}
        </div>
      </Section>
    </aside>
  );
}

function AgentRow({ role, slug }) {
  if (!slug) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px',
        background: 'var(--surface-muted)',
        border: '1px dashed var(--border-strong)',
        borderRadius: 6,
      }}>
        <div style={{ width: 22, height: 22, borderRadius: '50%', border: '1.5px dashed var(--border-strong)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ color: 'var(--muted-2)', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>{role}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>Unassigned · <a style={{ color: 'var(--accent)', cursor: 'pointer' }}>assign</a></div>
        </div>
      </div>
    );
  }
  const a = agentBySlug[slug];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 10px',
      background: 'var(--surface-muted)',
      border: '1px solid var(--border)',
      borderRadius: 6,
    }}>
      <AgentAvatar slug={slug} size={24} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: 'var(--muted-2)', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>{role}</div>
        <div style={{ color: 'var(--text)', fontSize: 13, fontWeight: 600 }}>{a.name}</div>
      </div>
      <button style={{
        padding: '3px 8px', fontSize: 11,
        background: 'transparent', color: 'var(--muted)',
        border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
      }}>change</button>
    </div>
  );
}

function CommentComposer() {
  const [val, setVal] = React.useState('');
  return (
    <div style={{
      padding: 12, background: 'var(--surface-muted)',
      border: '1px solid var(--border)', borderRadius: 8,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <textarea
        value={val} onChange={e => setVal(e.target.value)}
        placeholder="Leave a comment, or type / for agent commands…"
        rows={3}
        style={{
          background: 'transparent', border: 'none', color: 'var(--text)',
          fontSize: 13, fontFamily: 'var(--sans)', resize: 'none',
          outline: 'none', width: '100%', padding: 0,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ color: 'var(--muted-2)', fontSize: 11 }}>Type <span style={{ fontFamily: 'var(--mono)', padding: '1px 5px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }}>/</span> for agent commands</div>
        <button disabled={!val.trim()} style={{
          marginLeft: 'auto',
          padding: '6px 12px',
          background: val.trim() ? 'var(--accent)' : 'var(--surface)',
          color: val.trim() ? 'var(--accent-ink)' : 'var(--muted-2)',
          border: '1px solid var(--border-strong)', borderRadius: 6,
          fontSize: 12, fontWeight: 700,
          cursor: val.trim() ? 'pointer' : 'not-allowed',
        }}>Post</button>
      </div>
    </div>
  );
}

// Light-weight markdown renderer for agent comments (bold + inline code only).
function renderSimpleMd(src) {
  if (!src) return '';
  const esc = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc
    .replace(/`([^`]+)`/g, '<code style="font-family:var(--mono);font-size:0.92em;padding:1px 5px;background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:3px;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:700;color:var(--text);">$1</strong>');
}

function TaskDetailPage({ taskId, onBack }) {
  const task = taskById[taskId] || TASKS[0];
  const activity = React.useMemo(() => buildActivity(task), [task.id]);

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'grid', gridTemplateRows: 'auto 1fr',
      background: 'var(--bg)', fontFamily: 'var(--sans)', color: 'var(--text)',
      overflow: 'hidden',
    }}>
      <Breadcrumb onBack={onBack} taskId={task.id} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', minHeight: 0 }}>
        <div style={{ overflow: 'auto' }} className="wl-hide-scrollbar">
          <TaskHero task={task} />
          <div style={{ padding: '0 20px 24px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(task.status === 'in_progress' || task.status === 'in_review' || (task.liveEvents || []).length > 0) && (
              <Section title="Current run" action={
                <button style={{
                  padding: '3px 8px', fontSize: 11,
                  background: 'transparent', color: 'var(--muted)',
                  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                }}>Full log →</button>
              }>
                <LiveRunPanel task={task} />
              </Section>
            )}

            <Section title="Activity" count={activity.length}>
              <ActivityFeed activity={activity} task={task} />
            </Section>

            <Section title="Comment">
              <CommentComposer />
            </Section>
          </div>
        </div>
        <SidePanel task={task} />
      </div>
    </div>
  );
}

window.TaskDetailPage = TaskDetailPage;
