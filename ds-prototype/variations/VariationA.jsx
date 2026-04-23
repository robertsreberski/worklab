// Variation A — "Commander"  (revised)
// Linear-style dense list. Click a row to open TaskDetail.

function BlockedByChip({ deps }) {
  if (!deps || deps.length === 0) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      color: 'var(--muted)', fontSize: 10.5, fontWeight: 600,
      padding: '1px 6px',
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid var(--border)',
      borderRadius: 3,
    }} title={`Blocked by: ${deps.join(', ')}`}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
        <path d="M8 11V7a4 4 0 1 1 8 0v4m-10 0h12v10H6V11Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      blocked by {deps.length}
    </span>
  );
}

function FilterBar({ filters, setFilters, counts, total, onNew }) {
  const pill = (active) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 26, padding: '0 10px',
    borderRadius: 6,
    border: `1px solid ${active ? 'rgba(159,184,255,0.35)' : 'var(--border)'}`,
    background: active ? 'rgba(159,184,255,0.08)' : 'transparent',
    color: active ? 'var(--accent-strong)' : 'var(--text-soft)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  });
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 16px',
      borderBottom: '1px solid var(--border)',
      background: 'rgba(13,15,20,0.72)',
      backdropFilter: 'blur(10px)',
      position: 'sticky', top: 0, zIndex: 5,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '0 10px', height: 28, flex: '0 1 240px',
        background: 'var(--surface-muted)', border: '1px solid var(--border)',
        borderRadius: 6, color: 'var(--muted)',
      }}>
        <Ic name="search" size={12} color="var(--muted)" />
        <span style={{ fontSize: 12 }}>Search tasks…</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted-2)',
          border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px' }}>/</span>
      </div>
      <div style={{ width: 1, height: 18, background: 'var(--border)' }} />
      {STATUSES.map(s => (
        <button key={s.id} style={pill(filters.status === s.id)}
          onClick={() => setFilters(f => ({ ...f, status: f.status === s.id ? null : s.id }))}>
          <span style={{ color: s.color, fontSize: 9 }}>{s.icon}</span>
          {s.label}
          <span style={{ color: 'var(--muted-2)', fontSize: 11, fontWeight: 500 }}>{counts[s.id] || 0}</span>
        </button>
      ))}
      <div style={{ width: 1, height: 18, background: 'var(--border)' }} />
      <button style={pill(false)}>
        <Ic name="filter" size={11} />
        Agent
      </button>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{total} tasks</span>
        <button onClick={onNew} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 28, padding: '0 10px',
          background: 'var(--accent)', color: 'var(--accent-ink)',
          border: '1px solid var(--accent)', borderRadius: 6,
          fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}>
          <Ic name="plus" size={12} />
          New task
        </button>
      </div>
    </div>
  );
}

function TaskRowA({ task, selected, onSelect, showLiveStream, onOpen }) {
  const isRunning = task.status === 'in_progress' || task.status === 'in_review';
  const event = useLiveTicker(task.liveEvents || [], { running: isRunning, intervalMs: 2200 });

  return (
    <div
      onClick={onOpen}
      style={{
        display: 'grid',
        gridTemplateColumns: '18px 62px 18px minmax(0, 1fr) auto 120px 170px 80px',
        alignItems: 'center',
        gap: 10,
        padding: '9px 16px',
        borderBottom: '1px solid var(--border)',
        background: selected ? 'rgba(159,184,255,0.06)' : 'transparent',
        cursor: 'pointer',
        minHeight: showLiveStream && isRunning && event ? 54 : 40,
        transition: 'background .1s',
        fontSize: 13,
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      {/* Checkbox */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div onClick={(e) => { e.stopPropagation(); onSelect(); }} style={{
          width: 13, height: 13, borderRadius: 3,
          border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-strong)'}`,
          background: selected ? 'var(--accent)' : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {selected && <Ic name="check" size={9} color="var(--accent-ink)" />}
        </div>
      </div>

      {/* ID */}
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>
        {task.id}
      </span>

      {/* Status dot */}
      <span style={{ display: 'flex', justifyContent: 'center' }}>
        {isRunning ? <LivePulse color={statusById[task.status].color} size={7} /> :
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: statusById[task.status].color,
            opacity: task.status === 'done' ? 0.6 : 1,
          }} />}
      </span>

      {/* Title + live stream */}
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            color: 'var(--text)', fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{task.title}</span>
          {task.errorText && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              color: 'var(--red)', fontSize: 10.5, fontWeight: 700,
              background: 'rgba(255,116,126,0.08)',
              border: '1px solid rgba(255,116,126,0.22)',
              padding: '1px 6px', borderRadius: 3,
            }}>
              <Ic name="warn" size={10} color="var(--red)" />
              {task.retries} retries
            </span>
          )}
        </div>
        {showLiveStream && isRunning && event && (
          <div style={{ animation: 'wl-tick-in .3s' }} key={`${task.id}-${event.t}`}>
            <ToolToken event={event} compact />
          </div>
        )}
      </div>

      {/* Deps chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <BlockedByChip deps={task.dependsOn} />
      </div>

      {/* Executor → Reviewer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <AgentAvatar slug={task.executor} size={18} />
        {task.reviewer && (
          <>
            <Ic name="arrow-right" size={10} color="var(--muted-2)" />
            <AgentAvatar slug={task.reviewer} size={18} />
          </>
        )}
      </div>

      {/* Status pill */}
      <StatusPill status={task.status} size="sm" />

      {/* Age */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        color: 'var(--muted)', fontSize: 11,
      }}>
        {formatAge(task.updatedAt)}
      </div>
    </div>
  );
}

function VariationA({ showLiveStream = true, onOpenTask }) {
  const [filters, setFilters] = React.useState({ status: null });
  const [selected, setSelected] = React.useState(new Set());
  const [opened, setOpened] = React.useState('WRK-812');

  const counts = {};
  STATUSES.forEach(s => counts[s.id] = TASKS.filter(t => t.status === s.id).length);

  const filtered = TASKS.filter(t => !filters.status || t.status === filters.status);

  const groupOrder = ['in_progress', 'in_review', 'todo', 'error', 'done'];
  const grouped = groupOrder.map(g => ({
    status: statusById[g],
    tasks: filtered.filter(t => t.status === g),
  })).filter(g => g.tasks.length > 0);

  function openTask(id) {
    setOpened(id);
    onOpenTask?.(id);
  }

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)', fontFamily: 'var(--sans)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px 10px', borderBottom: '1px solid var(--border)',
      }}>
        <div>
          <div style={{ color: 'var(--muted-2)', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' }}>
            Worklab · Tasks
          </div>
          <h2 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 700, letterSpacing: -0.2 }}>All work</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: 12 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <LivePulse color="var(--green)" size={6} />
            3 agents active
          </span>
          <span>·</span>
          <span>$6.05 spent today</span>
          <span>·</span>
          <span>142k tokens</span>
        </div>
      </div>

      <FilterBar filters={filters} setFilters={setFilters} counts={counts} total={filtered.length} />

      <div style={{ flex: 1, overflow: 'auto' }} className="wl-hide-scrollbar">
        {grouped.map(g => (
          <div key={g.status.id}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '9px 16px 7px',
              background: 'var(--surface-muted)',
              borderBottom: '1px solid var(--border)',
              position: 'sticky', top: 0, zIndex: 1,
              fontSize: 11.5, fontWeight: 700, letterSpacing: 0.3,
              color: 'var(--text-soft)', textTransform: 'uppercase',
            }}>
              <span style={{ color: g.status.color, fontSize: 10 }}>{g.status.icon}</span>
              {g.status.label}
              <span style={{ color: 'var(--muted-2)', fontWeight: 500 }}>{g.tasks.length}</span>
            </div>
            {g.tasks.map(task => (
              <TaskRowA key={task.id}
                task={task}
                selected={opened === task.id}
                onSelect={() => {
                  setSelected(s => {
                    const n = new Set(s);
                    n.has(task.id) ? n.delete(task.id) : n.add(task.id);
                    return n;
                  });
                }}
                onOpen={() => openTask(task.id)}
                showLiveStream={showLiveStream}
              />
            ))}
          </div>
        ))}
      </div>

    </div>
  );
}

window.VariationA = VariationA;
