// Schedules page — recurring / scheduled tasks.
// A schedule is a template; it spawns task instances on a cadence.
//
// Two views in one artboard:
//  1. Index: a dense list of all schedules with a sparkline of recent runs
//  2. Detail: picked schedule shown on the right — cadence editor, next fires, history

function cronChip(schedule) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 8px',
      background: 'var(--surface-muted)',
      border: '1px solid var(--border)',
      borderRadius: 4,
      fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-soft)',
      fontWeight: 600,
    }}>
      <Ic name="clock" size={10} color="var(--muted)" />
      {schedule.expr}
    </span>
  );
}

// Sparkline of last N runs: each bar colored by status.
function HistorySpark({ history, height = 22, cols = 14 }) {
  const items = history.slice(0, cols);
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height }}>
      {Array.from({ length: cols }, (_, i) => {
        const h = items[i];
        const color = h ? (h.status === 'done' ? 'var(--green)' : 'var(--red)') : 'rgba(255,255,255,0.04)';
        const barH = h ? (3 + (i % 3) * 3 + (h.status === 'done' ? 6 : 10)) : 4;
        return (
          <div key={i} title={h ? `${h.status} · ${formatAge(h.t)}` : 'no run'} style={{
            width: 4, height: Math.min(barH, height - 2), background: color,
            borderRadius: 1, transition: 'height .2s',
          }} />
        );
      })}
    </div>
  );
}

function ScheduleRow({ s, selected, onSelect }) {
  const exec = agentBySlug[s.executor];
  return (
    <div
      onClick={() => onSelect(s.id)}
      style={{
        display: 'grid',
        gridTemplateColumns: '14px 1.6fr 0.9fr 0.9fr 120px 100px',
        gap: 14, alignItems: 'center',
        padding: '12px 14px',
        borderBottom: '1px solid var(--border)',
        background: selected ? 'rgba(159,184,255,0.06)' : 'transparent',
        borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
        cursor: 'pointer', transition: 'background .12s',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--surface-hover)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      {/* Enabled indicator */}
      <div style={{
        width: 10, height: 10, borderRadius: '50%',
        background: s.enabled ? 'var(--green)' : 'var(--muted-2)',
        border: s.enabled ? 'none' : '1.5px solid var(--border-strong)',
        boxShadow: s.enabled ? '0 0 0 3px rgba(106,214,157,0.12)' : 'none',
      }} />

      {/* Title + cadence */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, color: 'var(--text)', fontWeight: 650, letterSpacing: -0.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          {cronChip(s.schedule)}
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.schedule.human}</span>
        </div>
      </div>

      {/* Agents */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <AgentAvatar slug={s.executor} size={18} />
        <span style={{ fontSize: 12.5, color: 'var(--text-soft)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exec?.name}</span>
        {s.reviewer && (
          <>
            <Ic name="arrow-right" size={10} color="var(--muted-2)" />
            <AgentAvatar slug={s.reviewer} size={16} />
          </>
        )}
      </div>

      {/* Next run */}
      <div style={{ minWidth: 0 }}>
        {s.enabled ? (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 600 }}>
              {formatIn(s.nextRunAt)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>next fire</div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>paused</div>
        )}
      </div>

      {/* History sparkline */}
      <div>
        <HistorySpark history={s.history} />
        <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 3, fontFamily: 'var(--mono)' }}>
          {s.runsLast30} runs · <span style={{ color: s.failuresLast30 ? 'var(--red)' : 'var(--muted-2)' }}>{s.failuresLast30} failed</span>
        </div>
      </div>

      {/* Row actions */}
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
        <button style={iconAction()} title={s.enabled ? 'Pause' : 'Enable'}>
          {s.enabled ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5Z"/></svg>
          )}
        </button>
        <button style={iconAction()} title="Run now">
          <Ic name="zap" size={12} color="var(--text-soft)" />
        </button>
        <button style={iconAction()} title="Menu">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

function iconAction() {
  return {
    width: 24, height: 24, padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: '1px solid var(--border)',
    borderRadius: 4, color: 'var(--text-soft)', cursor: 'pointer',
  };
}

function SchedulesToolbar({ total, active, onNew }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '14px 22px',
      borderBottom: '1px solid var(--border)',
      background: 'rgba(13,15,20,0.72)',
      position: 'sticky', top: 0, zIndex: 5,
      backdropFilter: 'blur(14px)',
    }}>
      <div>
        <div style={{ fontSize: 10.5, color: 'var(--muted-2)', fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase' }}>
          Automations
        </div>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, letterSpacing: -0.2 }}>Schedules</h2>
      </div>
      <div style={{ display: 'flex', gap: 14, marginLeft: 18, fontSize: 11.5, color: 'var(--muted)' }}>
        <span><span style={{ color: 'var(--text)', fontWeight: 700 }}>{total}</span> schedules</span>
        <span>·</span>
        <span><span style={{ color: 'var(--green)', fontWeight: 700 }}>{active}</span> active</span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', background: 'var(--surface-muted)',
        border: '1px solid var(--border)', borderRadius: 6,
        color: 'var(--muted)', fontSize: 12, minWidth: 220,
      }}>
        <Ic name="search" size={13} color="var(--muted-2)" />
        Search schedules…
      </div>
      <button onClick={onNew} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '7px 12px', background: 'var(--accent)', color: 'var(--accent-ink)',
        border: '1px solid var(--accent)', borderRadius: 6,
        fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
      }}>
        <Ic name="plus" size={12} color="var(--accent-ink)" />
        New schedule
      </button>
    </div>
  );
}

function DetailHeader({ s }) {
  return (
    <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted-2)', fontWeight: 600 }}>{s.id}</span>
        <span style={{
          padding: '2px 7px',
          background: s.enabled ? 'rgba(106,214,157,0.14)' : 'rgba(148,143,134,0.12)',
          border: `1px solid ${s.enabled ? 'rgba(106,214,157,0.35)' : 'var(--border-strong)'}`,
          color: s.enabled ? 'var(--green)' : 'var(--muted)',
          borderRadius: 3, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
          display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
          {s.enabled && <LivePulse color="var(--green)" size={5} />}
          {s.enabled ? 'Enabled' : 'Paused'}
        </span>
      </div>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, letterSpacing: -0.2, lineHeight: 1.3 }}>{s.title}</h3>
      <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.55 }}>{s.description}</p>

      <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
        <button style={detailBtn(true)}>
          <Ic name="zap" size={11} color="var(--accent-ink)" />
          Run now
        </button>
        <button style={detailBtn(false)}>
          {s.enabled ? 'Pause' : 'Enable'}
        </button>
        <button style={detailBtn(false)}>Edit</button>
        <button style={{ ...detailBtn(false), marginLeft: 'auto', width: 28, padding: 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

function detailBtn(primary) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '6px 11px',
    background: primary ? 'var(--accent)' : 'var(--surface-raised)',
    color: primary ? 'var(--accent-ink)' : 'var(--text-soft)',
    border: `1px solid ${primary ? 'var(--accent)' : 'var(--border-strong)'}`,
    borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer',
  };
}

function CadenceEditor({ s }) {
  return (
    <section style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
      <SectionTitle label="Cadence" />
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
        padding: 12, background: 'var(--surface-muted)',
        border: '1px solid var(--border)', borderRadius: 6, marginBottom: 10,
      }}>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--muted-2)', fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>Expression</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)', marginTop: 3, fontWeight: 600 }}>
            {s.schedule.expr}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--muted-2)', fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>In plain English</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-soft)', marginTop: 3, fontWeight: 600 }}>
            {s.schedule.human}
          </div>
        </div>
      </div>

      {/* Upcoming fires */}
      <div style={{ fontSize: 10.5, color: 'var(--muted-2)', fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 6 }}>Upcoming</div>
      <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        {upcomingFires(s).map((f, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '1fr auto', gap: 10,
            padding: '7px 11px', alignItems: 'center',
            borderTop: i > 0 ? '1px solid var(--border)' : 'none',
            background: i === 0 ? 'rgba(159,184,255,0.04)' : 'transparent',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {i === 0 && <LivePulse color="var(--accent)" size={5} />}
              <span style={{ fontSize: 12.5, color: i === 0 ? 'var(--text)' : 'var(--text-soft)', fontWeight: i === 0 ? 700 : 500 }}>
                {fireLabel(f)}
              </span>
            </div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)' }}>
              {formatIn(f)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function upcomingFires(s) {
  // Synthesize next 5 fires from schedule cadence (static mock).
  if (!s.enabled) return [];
  const base = s.nextRunAt;
  const periodMs = (() => {
    if (s.schedule.expr.startsWith('*/30')) return 30 * 60_000;
    if (s.schedule.expr.startsWith('0 3')) return 24 * 3_600_000;
    if (s.schedule.expr.startsWith('0 9 * * 1')) return 7 * 24 * 3_600_000;
    if (s.schedule.expr.startsWith('0 16 * * 5')) return 7 * 24 * 3_600_000;
    return 6 * 3_600_000;
  })();
  return Array.from({ length: 5 }, (_, i) => base + i * periodMs);
}

function fireLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return 'Today · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function AgentsBlock({ s }) {
  return (
    <section style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
      <SectionTitle label="Agents" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <AgentRowLite slug={s.executor} role="Executor" />
        <AgentRowLite slug={s.reviewer} role="Reviewer" allowNone />
      </div>
    </section>
  );
}

function AgentRowLite({ slug, role, allowNone }) {
  if (!slug) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px',
        background: 'var(--surface-muted)', border: '1px dashed var(--border-strong)',
        borderRadius: 6,
      }}>
        <div style={{ width: 22, height: 22, borderRadius: '50%', border: '1.5px dashed var(--border-strong)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: 'var(--muted-2)', fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>{role}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>None</div>
        </div>
      </div>
    );
  }
  const a = agentBySlug[slug];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px',
      background: 'var(--surface-muted)', border: '1px solid var(--border)',
      borderRadius: 6,
    }}>
      <AgentAvatar slug={slug} size={22} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: 'var(--muted-2)', fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>{role}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 700 }}>{a?.name}</div>
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted-2)' }}>{a?.model}</span>
    </div>
  );
}

function StatsBlock({ s }) {
  return (
    <section style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
      <SectionTitle label="Last 30 days" />
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1,
        background: 'var(--border)', border: '1px solid var(--border)',
        borderRadius: 6, overflow: 'hidden',
      }}>
        {[
          ['Runs', s.runsLast30],
          ['Failures', s.failuresLast30, s.failuresLast30 ? 'var(--red)' : 'var(--text)'],
          ['Success', `${Math.round(((s.runsLast30 - s.failuresLast30) / Math.max(s.runsLast30,1)) * 100)}%`],
        ].map(([l, v, c]) => (
          <div key={l} style={{ padding: '10px 12px', background: 'var(--bg)' }}>
            <div style={{ fontSize: 9.5, color: 'var(--muted-2)', fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>{l}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 15, color: c || 'var(--text)', fontWeight: 700, marginTop: 3 }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <HistorySpark history={s.history} cols={30} height={28} />
        <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 4, fontFamily: 'var(--mono)', display: 'flex', justifyContent: 'space-between' }}>
          <span>30 days ago</span><span>now</span>
        </div>
      </div>
    </section>
  );
}

function RecentRunsBlock({ s }) {
  return (
    <section style={{ padding: 16 }}>
      <SectionTitle label="Recent runs" action={<a style={{ fontSize: 11, color: 'var(--accent)', cursor: 'pointer' }}>View all →</a>} />
      <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        {s.history.slice(0, 6).map((h, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '10px 1fr 80px', gap: 10,
            padding: '7px 11px', alignItems: 'center',
            borderTop: i > 0 ? '1px solid var(--border)' : 'none',
            cursor: 'pointer',
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: h.status === 'done' ? 'var(--green)' : 'var(--red)',
            }} />
            <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>
              {h.status === 'done' ? 'Completed' : 'Failed'} · spawned 1 task
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', textAlign: 'right' }}>
              {formatAge(h.t)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionTitle({ label, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <h4 style={{
        margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
        color: 'var(--text-soft)',
      }}>{label}</h4>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      {action}
    </div>
  );
}

function EmptyPanel() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: 'var(--muted)', fontSize: 13, padding: 40, textAlign: 'center',
    }}>
      Select a schedule to view its cadence, agents, and history.
    </div>
  );
}

function SchedulesPage() {
  const [selectedId, setSelectedId] = React.useState('SCH-01');
  const [showNew, setShowNew] = React.useState(false);
  const active = SCHEDULES.filter(s => s.enabled).length;
  const selected = scheduleById[selectedId];

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'grid', gridTemplateRows: 'auto 1fr',
      background: 'var(--bg)', fontFamily: 'var(--sans)', color: 'var(--text)',
      overflow: 'hidden',
    }}>
      <SchedulesToolbar total={SCHEDULES.length} active={active} onNew={() => setShowNew(true)} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', minHeight: 0 }}>
        {/* List */}
        <div className="wl-hide-scrollbar" style={{ overflow: 'auto', borderRight: '1px solid var(--border)' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '14px 1.6fr 0.9fr 0.9fr 120px 100px',
            gap: 14,
            padding: '10px 14px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface-muted)',
            fontSize: 10, color: 'var(--muted-2)', fontWeight: 700,
            letterSpacing: 0.4, textTransform: 'uppercase',
          }}>
            <span />
            <span>Schedule</span>
            <span>Agents</span>
            <span>Next</span>
            <span>Last 14</span>
            <span style={{ textAlign: 'right' }}>Actions</span>
          </div>
          {SCHEDULES.map(s => (
            <ScheduleRow key={s.id} s={s} selected={s.id === selectedId} onSelect={setSelectedId} />
          ))}
          <div style={{ padding: 14 }}>
            <button onClick={() => setShowNew(true)} style={{
              width: '100%', padding: 12,
              background: 'transparent', color: 'var(--accent)',
              border: '1px dashed var(--border-strong)', borderRadius: 6,
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            }}>
              <Ic name="plus" size={12} color="var(--accent)" />
              New schedule
            </button>
          </div>
        </div>

        {/* Detail */}
        <aside className="wl-hide-scrollbar" style={{ overflow: 'auto', background: 'rgba(13,15,20,0.4)' }}>
          {selected ? (
            <>
              <DetailHeader s={selected} />
              <CadenceEditor s={selected} />
              <AgentsBlock s={selected} />
              <StatsBlock s={selected} />
              <RecentRunsBlock s={selected} />
            </>
          ) : <EmptyPanel />}
        </aside>
      </div>

      {showNew && <NewScheduleModal onClose={() => setShowNew(false)} />}
    </div>
  );
}

// ---------- New schedule modal ----------
function NewScheduleModal({ onClose }) {
  const [step, setStep] = React.useState(1);
  const [form, setForm] = React.useState({
    title: '', description: '', cadence: 'daily', time: '03:00',
    executor: 'atlas', reviewer: null,
  });
  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 50,
      background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(10px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 560, maxHeight: '86vh',
        background: 'var(--surface)', border: '1px solid var(--border-strong)',
        borderRadius: 10, boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Ic name="clock" size={14} color="var(--accent)" />
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>New schedule</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {[1,2,3].map(n => (
              <span key={n} style={{
                width: 18, height: 3, borderRadius: 2,
                background: step >= n ? 'var(--accent)' : 'var(--border)',
              }} />
            ))}
          </div>
          <button onClick={onClose} style={{
            width: 24, height: 24, padding: 0, background: 'transparent',
            border: 'none', color: 'var(--muted)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Ic name="x" size={14} color="var(--muted)" /></button>
        </div>

        <div className="wl-hide-scrollbar" style={{ padding: 18, overflow: 'auto', flex: 1 }}>
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={modalKicker}>Step 1 · The task template</div>
                <h3 style={modalTitle}>What should this schedule do?</h3>
                <p style={modalCopy}>Each time the schedule fires, we'll spawn a new task using this brief.</p>
              </div>
              <FieldLite label="Title">
                <input value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Nightly dependency audit" style={inputS} autoFocus />
              </FieldLite>
              <FieldLite label="Description" hint="Shown to humans and agents">
                <textarea rows={3} value={form.description} onChange={e => set('description', e.target.value)} placeholder="What the agent should do each run…" style={{ ...inputS, fontFamily: 'var(--sans)', resize: 'vertical' }} />
              </FieldLite>
            </div>
          )}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={modalKicker}>Step 2 · Cadence</div>
                <h3 style={modalTitle}>When should it run?</h3>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {[
                  ['hourly', 'Every hour'],
                  ['daily', 'Every day'],
                  ['weekdays', 'Weekdays'],
                  ['weekly', 'Weekly'],
                  ['monthly', 'Monthly'],
                  ['cron', 'Custom (cron)'],
                ].map(([k, l]) => {
                  const on = form.cadence === k;
                  return (
                    <button key={k} onClick={() => set('cadence', k)} style={{
                      padding: '10px 8px', textAlign: 'center',
                      background: on ? 'rgba(159,184,255,0.1)' : 'var(--surface-muted)',
                      border: `1px solid ${on ? 'rgba(159,184,255,0.4)' : 'var(--border)'}`,
                      color: on ? 'var(--accent-strong)' : 'var(--text-soft)',
                      borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    }}>{l}</button>
                  );
                })}
              </div>
              <FieldLite label={form.cadence === 'cron' ? 'Cron expression' : 'Time'}>
                <input value={form.cadence === 'cron' ? '0 3 * * *' : form.time} onChange={e => set('time', e.target.value)} style={{ ...inputS, fontFamily: 'var(--mono)' }} />
              </FieldLite>
              <div style={{
                padding: 12, background: 'var(--surface-muted)',
                border: '1px solid var(--border)', borderRadius: 6,
                fontSize: 12, color: 'var(--text-soft)',
              }}>
                <span style={{ color: 'var(--muted)' }}>Preview:</span> Next three fires · <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>tomorrow 03:00</span>, <span style={{ fontFamily: 'var(--mono)' }}>Thu 03:00</span>, <span style={{ fontFamily: 'var(--mono)' }}>Fri 03:00</span>
              </div>
            </div>
          )}
          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={modalKicker}>Step 3 · Agents</div>
                <h3 style={modalTitle}>Who does the work?</h3>
              </div>
              <FieldLite label="Executor">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {AGENTS.filter(a => a.role === 'executor').map(a => {
                    const on = form.executor === a.slug;
                    return (
                      <label key={a.slug} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                        background: on ? `color-mix(in oklch, ${a.color} 10%, transparent)` : 'var(--surface-muted)',
                        border: `1px solid ${on ? `color-mix(in oklch, ${a.color} 40%, transparent)` : 'var(--border)'}`,
                        borderRadius: 6, cursor: 'pointer',
                      }}>
                        <input type="radio" checked={on} onChange={() => set('executor', a.slug)} style={{ accentColor: a.color }} />
                        <AgentAvatar slug={a.slug} size={22} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 700 }}>{a.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{a.title}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </FieldLite>
            </div>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1} style={{
            padding: '7px 12px', background: 'var(--surface-muted)',
            border: '1px solid var(--border)', borderRadius: 6,
            color: step === 1 ? 'var(--muted-2)' : 'var(--text-soft)',
            fontSize: 12.5, fontWeight: 600, cursor: step === 1 ? 'not-allowed' : 'pointer',
          }}>Back</button>
          <div style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>Step {step} of 3</div>
          {step < 3 ? (
            <button onClick={() => setStep(s => s + 1)} style={detailBtn(true)}>Continue</button>
          ) : (
            <button onClick={onClose} style={detailBtn(true)}>Create schedule</button>
          )}
        </div>
      </div>
    </div>
  );
}

const modalKicker = { fontSize: 10.5, color: 'var(--muted-2)', fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' };
const modalTitle = { margin: '4px 0 0', fontSize: 17, fontWeight: 700, letterSpacing: -0.2 };
const modalCopy = { margin: '6px 0 0', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 };
const inputS = {
  width: '100%', padding: '9px 11px', background: 'var(--surface-muted)',
  color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 6,
  fontSize: 13, outline: 'none', boxSizing: 'border-box',
};

function FieldLite({ label, hint, children }) {
  return (
    <div>
      <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-soft)', display: 'block', marginBottom: 6 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

window.SchedulesPage = SchedulesPage;
window.NewScheduleModal = NewScheduleModal;
