// Task Edit page — full-page edit for all task fields.
// Designed to match the Commander aesthetic: dense, keyboard-ready, clear groupings.

function EditHeader({ task, onCancel }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '14px 22px', borderBottom: '1px solid var(--border)',
      background: 'rgba(13,15,20,0.72)', position: 'sticky', top: 0, zIndex: 10,
      backdropFilter: 'blur(14px)',
    }}>
      <button onClick={onCancel} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: 'transparent', border: 'none', color: 'var(--muted)',
        fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0,
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>
      <span style={{ color: 'var(--muted-2)' }}>/</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)' }}>{task.id}</span>
      <span style={{ color: 'var(--muted-2)' }}>/</span>
      <span style={{ fontSize: 12.5, color: 'var(--text-soft)', fontWeight: 600 }}>Edit</span>

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 7, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
          <span style={{ padding: '2px 5px', background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 3, marginRight: 4 }}>⌘S</span>
          save
        </span>
        <button onClick={onCancel} style={{
          padding: '7px 14px', background: 'var(--surface-raised)', color: 'var(--text-soft)',
          border: '1px solid var(--border-strong)', borderRadius: 6,
          fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
        }}>Cancel</button>
        <button style={{
          padding: '7px 14px', background: 'var(--accent)', color: 'var(--accent-ink)',
          border: '1px solid var(--accent)', borderRadius: 6,
          fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}>Save changes</button>
      </div>
    </div>
  );
}

function Field({ label, hint, kicker, children, wide }) {
  return (
    <div style={{ gridColumn: wide ? '1 / -1' : 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <label style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
          textTransform: 'uppercase', color: 'var(--text-soft)',
        }}>{label}</label>
        {kicker && <span style={{ fontSize: 10.5, color: 'var(--muted-2)', fontFamily: 'var(--mono)' }}>{kicker}</span>}
      </div>
      {children}
      {hint && <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 5, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

function TextInput({ value, onChange, mono, placeholder, autofocus }) {
  return (
    <input
      value={value} onChange={e => onChange?.(e.target.value)} placeholder={placeholder}
      autoFocus={autofocus}
      style={{
        width: '100%', padding: '9px 11px',
        background: 'var(--surface-muted)', color: 'var(--text)',
        border: '1px solid var(--border-strong)', borderRadius: 6,
        fontFamily: mono ? 'var(--mono)' : 'var(--sans)',
        fontSize: mono ? 12.5 : 13.5, fontWeight: mono ? 500 : 600,
        outline: 'none',
      }}
    />
  );
}

function TextArea({ value, onChange, rows = 4, mono, placeholder }) {
  return (
    <textarea
      value={value} onChange={e => onChange?.(e.target.value)} rows={rows} placeholder={placeholder}
      style={{
        width: '100%', padding: '10px 12px',
        background: 'var(--surface-muted)', color: 'var(--text)',
        border: '1px solid var(--border-strong)', borderRadius: 6,
        fontFamily: mono ? 'var(--mono)' : 'var(--sans)',
        fontSize: mono ? 12 : 13.5, lineHeight: 1.55,
        resize: 'vertical', outline: 'none',
      }}
    />
  );
}

function AgentPicker({ role, slug, onChange, allowNone, label = 'agent' }) {
  const agents = AGENTS.filter(a => !role || a.role === role);
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const rootRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const selected = slug ? agentBySlug[slug] : null;
  const filtered = agents.filter(a => {
    if (!q) return true;
    const s = q.toLowerCase();
    return a.name.toLowerCase().includes(s)
        || (a.title || '').toLowerCase().includes(s)
        || (a.model || '').toLowerCase().includes(s);
  });

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 10px', textAlign: 'left',
          background: 'var(--surface-muted)',
          border: `1px solid ${open ? 'var(--accent)' : 'var(--border-strong)'}`,
          borderRadius: 6, cursor: 'pointer',
        }}>
        {selected ? (
          <>
            <AgentAvatar slug={selected.slug} size={22} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 700 }}>{selected.name}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected.title} · <span style={{ fontFamily: 'var(--mono)' }}>{selected.model}</span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div style={{
              width: 22, height: 22, borderRadius: '50%',
              border: '1.5px dashed var(--border-strong)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--muted-2)', fontSize: 11,
            }}>—</div>
            <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--muted)' }}>
              Search {label}…
            </div>
          </>
        )}
        <span style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s', color: 'var(--muted-2)', display: 'flex' }}>
          <Ic name="chevron-down" size={12} color="var(--muted-2)" />
        </span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          borderRadius: 8, boxShadow: '0 18px 44px rgba(0,0,0,0.55)', overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 10px', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-muted)',
          }}>
            <Ic name="search" size={12} color="var(--muted-2)" />
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={`Search ${agents.length} ${label}s…`}
              style={{
                flex: 1, background: 'transparent', border: 'none', color: 'var(--text)',
                fontSize: 12.5, outline: 'none', padding: 0,
              }}
            />
            <span style={{ color: 'var(--muted-2)', fontFamily: 'var(--mono)', fontSize: 10, padding: '1px 5px', border: '1px solid var(--border)', borderRadius: 3 }}>esc</span>
          </div>
          <div style={{ maxHeight: 260, overflow: 'auto', padding: 4 }} className="wl-hide-scrollbar">
            {allowNone && (
              <button type="button"
                onClick={() => { onChange?.(null); setOpen(false); setQ(''); }}
                style={rowBtn(!slug)}>
                <div style={{ width: 22, height: 22, borderRadius: '50%', border: '1.5px dashed var(--border-strong)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted-2)', fontSize: 11 }}>—</div>
                <div style={{ flex: 1, fontSize: 12.5, color: 'var(--text-soft)', fontWeight: 600 }}>None</div>
              </button>
            )}
            {filtered.map(a => (
              <button
                key={a.slug}
                type="button"
                onClick={() => { onChange?.(a.slug); setOpen(false); setQ(''); }}
                style={rowBtn(slug === a.slug)}>
                <AgentAvatar slug={a.slug} size={22} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 700 }}>{a.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.title} · <span style={{ fontFamily: 'var(--mono)' }}>{a.model}</span>
                  </div>
                </div>
                {a.role === 'reviewer' && <span style={{ padding: '1px 6px', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', background: 'rgba(198,166,255,0.14)', color: 'var(--purple)', borderRadius: 3 }}>Review</span>}
                {slug === a.slug && <Ic name="check" size={12} color="var(--accent)" />}
              </button>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: '14px 10px', fontSize: 12, color: 'var(--muted-2)', textAlign: 'center', fontStyle: 'italic' }}>
                No {label}s match “{q}”
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function rowBtn(active) {
  return {
    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
    padding: '7px 8px', textAlign: 'left',
    background: active ? 'rgba(159,184,255,0.08)' : 'transparent',
    color: 'var(--text-soft)',
    border: `1px solid ${active ? 'rgba(159,184,255,0.25)' : 'transparent'}`,
    borderRadius: 5, cursor: 'pointer',
    marginBottom: 2,
  };
}

function iconBtn(disabled, color) {
  return {
    width: 24, height: 24, padding: 0,
    background: 'transparent', color: color || 'var(--muted)',
    border: '1px solid var(--border)', borderRadius: 4,
    fontSize: 13, fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}

function DepPicker({ selected: initial, taskId }) {
  const [selected, setSelected] = React.useState(initial || []);
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const candidates = TASKS.filter(t => t.id !== taskId);
  const filtered = candidates.filter(t => !selected.includes(t.id) && (
    q === '' || t.title.toLowerCase().includes(q.toLowerCase()) || t.id.toLowerCase().includes(q.toLowerCase())
  )).slice(0, 5);

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {selected.map(id => {
          const t = taskById[id];
          if (!t) return null;
          return (
            <div key={id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px',
              background: 'var(--surface-muted)',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusById[t.status].color }} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>{t.id}</span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
              <button
                onClick={() => setSelected(s => s.filter(x => x !== id))}
                style={{ ...iconBtn(false, 'var(--red)'), width: 22, height: 22 }}
              >×</button>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: selected.length ? 8 : 0, position: 'relative' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 10px',
          background: 'var(--surface-muted)',
          border: `1px ${open ? 'solid var(--accent)' : 'dashed var(--border-strong)'}`,
          borderRadius: 6,
        }}>
          <Ic name="search" size={13} color="var(--muted-2)" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            placeholder="Link another task…"
            style={{
              flex: 1, background: 'transparent', border: 'none', color: 'var(--text)',
              fontSize: 13, outline: 'none', padding: 0,
            }}
          />
          <span style={{ color: 'var(--muted-2)', fontFamily: 'var(--mono)', fontSize: 11 }}>WRK-</span>
        </div>
        {open && filtered.length > 0 && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20,
            background: 'var(--surface)', border: '1px solid var(--border-strong)',
            borderRadius: 6, boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            padding: 4,
          }}>
            {filtered.map(t => (
              <button
                key={t.id}
                onMouseDown={() => { setSelected(s => [...s, t.id]); setQ(''); }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 10px', background: 'transparent',
                  border: 'none', borderRadius: 4, cursor: 'pointer',
                  color: 'var(--text-soft)', textAlign: 'left',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusById[t.status].color }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>{t.id}</span>
                <span style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScheduleEditor({ enabled: initialEnabled }) {
  const [enabled, setEnabled] = React.useState(initialEnabled || false);
  const [mode, setMode] = React.useState('daily');
  const [time, setTime] = React.useState('03:00');

  return (
    <div style={{
      padding: 14, background: 'var(--surface-muted)',
      border: '1px solid var(--border)', borderRadius: 8,
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: enabled ? 14 : 0 }}>
        <div style={{
          width: 32, height: 18, borderRadius: 999, padding: 2,
          background: enabled ? 'var(--accent)' : 'var(--surface)',
          border: '1px solid var(--border-strong)',
          display: 'flex', justifyContent: enabled ? 'flex-end' : 'flex-start',
          transition: 'all .15s',
        }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: enabled ? 'var(--accent-ink)' : 'var(--muted)' }} />
        </div>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} style={{ display: 'none' }} />
        <div>
          <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 700 }}>Run on a schedule</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Spawn a new task instance automatically</div>
        </div>
      </label>
      {enabled && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 }}>
          <select
            value={mode} onChange={e => setMode(e.target.value)}
            style={{
              padding: '8px 10px', background: 'var(--surface)', color: 'var(--text)',
              border: '1px solid var(--border-strong)', borderRadius: 6,
              fontSize: 12.5, fontWeight: 600, appearance: 'none', cursor: 'pointer',
            }}>
            <option value="hourly">Every hour</option>
            <option value="interval">Every N hours…</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Weekly</option>
            <option value="cron">Custom (cron)</option>
          </select>
          <TextInput value={time} onChange={setTime} mono />
          <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: 'var(--muted)' }}>
            Next run: <span style={{ color: 'var(--text-soft)', fontFamily: 'var(--mono)' }}>tomorrow at {time} UTC</span>
            <span style={{ color: 'var(--muted-2)' }}> · or </span>
            <a style={{ color: 'var(--accent)', cursor: 'pointer' }}>convert to recurring template</a>
          </div>
        </div>
      )}
    </div>
  );
}

function DangerZone({ task }) {
  return (
    <div style={{
      marginTop: 28, padding: 16,
      background: 'rgba(255,116,126,0.04)',
      border: '1px solid rgba(255,116,126,0.22)',
      borderRadius: 8,
    }}>
      <div style={{ fontSize: 11.5, color: 'var(--red)', fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 10 }}>Danger zone</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {[
          ['Archive task', 'Removes from active views. Runs are preserved.', 'Archive'],
          ['Delete task', 'Permanently delete this task and all its runs.', 'Delete'],
        ].map(([title, help, label]) => (
          <div key={label} style={{
            padding: 12, background: 'var(--surface-muted)',
            border: '1px solid var(--border)', borderRadius: 6,
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 700 }}>{title}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>{help}</div>
            <button style={{
              alignSelf: 'flex-start', marginTop: 4,
              padding: '6px 12px',
              background: 'transparent', color: 'var(--red)',
              border: '1px solid rgba(255,116,126,0.35)',
              borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}>{label}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function EditTaskPage({ taskId, onCancel }) {
  const task = taskById[taskId] || TASKS[0];
  const [draft, setDraft] = React.useState({
    title: task.title,
    instructions: 'Reproduce locally with `pnpm test auth.integration --repeat 50`.\nIdentify the race, patch, verify with 20 consecutive passing runs.',
    executor: task.executor, reviewer: task.reviewer, status: task.status,
    dependsOn: task.dependsOn,
  });
  function set(k, v) { setDraft(d => ({ ...d, [k]: v })); }

  return (
    <div style={{
      width: '100%', height: '100%', display: 'grid', gridTemplateRows: 'auto 1fr',
      background: 'var(--bg)', fontFamily: 'var(--sans)', color: 'var(--text)', overflow: 'hidden',
    }}>
      <EditHeader task={task} onCancel={onCancel} />
      <div className="wl-hide-scrollbar" style={{ overflow: 'auto' }}>
        <div style={{
          maxWidth: 960, margin: '0 auto', padding: '28px 28px 60px',
          display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 32, alignItems: 'flex-start',
        }}>
          {/* Main column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div>
              <div style={{ fontSize: 10.5, color: 'var(--muted-2)', fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
                Editing task
              </div>
              <h1 style={{
                margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: -0.3, lineHeight: 1.2,
              }}>
                <span style={{ color: 'var(--muted-2)', fontFamily: 'var(--mono)', fontSize: 15, marginRight: 10, fontWeight: 600 }}>{task.id}</span>
                {draft.title || <span style={{ color: 'var(--muted-2)', fontStyle: 'italic' }}>Untitled task</span>}
              </h1>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, rowGap: 20 }}>
              <Field label="Title" wide>
                <TextInput value={draft.title} onChange={v => set('title', v)} autofocus />
              </Field>

              <Field
                label="Instructions"
                kicker="agent prompt"
                hint="Supports markdown. Reference other tasks with @WRK-812, knowledge entries with #kb, and skills with !skill."
                wide>
                <TextArea value={draft.instructions} onChange={v => set('instructions', v)} rows={10} mono />
              </Field>

              <Field label="Dependencies" kicker="blocks this task" wide>
                <DepPicker selected={draft.dependsOn} taskId={task.id} />
              </Field>

              <Field label="Schedule" wide>
                <ScheduleEditor enabled={false} />
              </Field>
            </div>

            <DangerZone task={task} />
          </div>

          {/* Right column — assignment & status */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 20,
            position: 'sticky', top: 78,
          }}>
            <Field label="Status">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                {STATUSES.map(s => {
                  const active = draft.status === s.id;
                  return (
                    <button key={s.id}
                      onClick={() => set('status', s.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '7px 9px',
                        background: active ? `color-mix(in oklch, ${s.color} 14%, transparent)` : 'var(--surface-muted)',
                        border: `1px solid ${active ? `color-mix(in oklch, ${s.color} 45%, transparent)` : 'var(--border)'}`,
                        color: active ? s.color : 'var(--text-soft)',
                        borderRadius: 5, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                      }}>
                      <span style={{ fontSize: 9 }}>{s.icon}</span>
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Executor" kicker="required">
              <AgentPicker role={null} slug={draft.executor} onChange={v => set('executor', v)} label="agent" />
            </Field>

            <Field label="Reviewer" kicker="optional">
              <AgentPicker role={null} slug={draft.reviewer} onChange={v => set('reviewer', v)} allowNone label="reviewer" />
            </Field>
          </div>
        </div>
      </div>
    </div>
  );
}

window.EditTaskPage = EditTaskPage;
