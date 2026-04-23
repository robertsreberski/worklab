// Main app: design canvas for the Worklab task-management UI.
// Pages: Commander (list), TaskDetail, Edit, Schedules, Agents, Skills, Knowledge.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "showLiveStream": true,
  "defaultVariation": "commander"
}/*EDITMODE-END*/;

const FOCUS_OPTIONS = [
  ['commander', 'Commander · task list'],
  ['detail', 'Task detail'],
  ['edit', 'Create / edit task'],
  ['schedules', 'Schedules'],
  ['agents', 'Agents'],
  ['skills', 'Skills'],
  ['knowledge', 'Knowledge base'],
  ['all', 'All pages'],
];

function TweaksPanel({ tweaks, setTweaks, visible }) {
  if (!visible) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 20, right: 20, zIndex: 100,
      width: 300, padding: 16,
      background: 'var(--surface)', color: 'var(--text)',
      border: '1px solid var(--border-strong)', borderRadius: 10,
      boxShadow: '0 20px 50px rgba(0,0,0,0.5)', fontFamily: 'var(--sans)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>Tweaks</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>live</span>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '8px 0' }}>
        <input type="checkbox" checked={tweaks.showLiveStream}
          onChange={e => setTweaks(t => ({ ...t, showLiveStream: e.target.checked }))}
          style={{ accentColor: 'var(--accent)' }} />
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Inline live streams</div>
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>Show tool calls on task rows</div>
        </div>
      </label>
      <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
      <div style={{ fontSize: 11, color: 'var(--muted-2)', fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>Focus</div>
      <div style={{ display: 'grid', gap: 4 }}>
        {FOCUS_OPTIONS.map(([k, l]) => (
          <button key={k} onClick={() => setTweaks(t => ({ ...t, defaultVariation: k }))}
            style={{
              textAlign: 'left', padding: '6px 10px', fontSize: 12,
              background: tweaks.defaultVariation === k ? 'rgba(159,184,255,0.1)' : 'transparent',
              color: tweaks.defaultVariation === k ? 'var(--accent-strong)' : 'var(--text-soft)',
              border: `1px solid ${tweaks.defaultVariation === k ? 'rgba(159,184,255,0.3)' : 'var(--border)'}`,
              borderRadius: 6, cursor: 'pointer', fontWeight: 600,
            }}>{l}</button>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [tweaks, setTweaks] = React.useState(TWEAK_DEFAULTS);
  const [editMode, setEditMode] = React.useState(false);
  const [openedId, setOpenedId] = React.useState('WRK-812');

  React.useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === '__activate_edit_mode') setEditMode(true);
      if (e.data?.type === '__deactivate_edit_mode') setEditMode(false);
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  React.useEffect(() => {
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: tweaks }, '*');
  }, [tweaks]);

  const v = tweaks.defaultVariation;
  const show = (k) => v === k || v === 'all';
  // Detail is always useful to keep alongside commander (it opens from a list row).
  const showDetail = v === 'detail' || v === 'all' || v === 'commander';

  return (
    <React.Fragment>
      <DesignCanvas>
        {show('commander') && (
          <DCSection id="commander" title="Commander · task list"
            subtitle="The home page. Dense, keyboard-first list of every task. Subtasks expand inline. Blocked-by chips show dependencies. No repo / branch / priority — agents decide.">
            <DCArtboard id="a-list" label="Unified list view" width={1320} height={820}>
              <VariationA showLiveStream={tweaks.showLiveStream} onOpenTask={setOpenedId} />
            </DCArtboard>
          </DCSection>
        )}

        {showDetail && (
          <DCSection id="detail" title="Task detail"
            subtitle="Opens on ↵ or row click. Left: title, agent instructions, live run stream, activity feed (thoughts · tool calls · handoffs · comments), and a composer with slash-commands. Right rail: agents, dependencies, metrics.">
            <DCArtboard id="detail-main" label={`Detail · ${openedId}`} width={1320} height={960}>
              <TaskDetailPage taskId={openedId} onBack={() => {}} onOpen={setOpenedId} />
            </DCArtboard>
            <DCArtboard id="detail-blocked" label="Detail · blocked / incident" width={1320} height={960}>
              <TaskDetailPage taskId="WRK-801" onBack={() => {}} onOpen={setOpenedId} />
            </DCArtboard>
          </DCSection>
        )}

        {show('edit') && (
          <DCSection id="edit" title="Create / edit task"
            subtitle="One form covers new tasks, edits, and scheduled-task templates. Title + agent instructions drive everything; assignment, dependencies, schedule, and advanced policy sit in the right rail.">
            <DCArtboard id="edit-new" label="Create new task" width={1260} height={920}>
              <EditTaskPage mode="create" />
            </DCArtboard>
            <DCArtboard id="edit-existing" label="Edit existing · WRK-812" width={1260} height={920}>
              <EditTaskPage mode="edit" taskId="WRK-812" />
            </DCArtboard>
          </DCSection>
        )}

        {show('schedules') && (
          <DCSection id="schedules" title="Schedules"
            subtitle="Recurring task templates. Each schedule spawns a real task on its cadence. List + detail with cron editor, upcoming fires, 30-day run history.">
            <DCArtboard id="schedules-list" label="Schedules index + detail" width={1440} height={880}>
              <SchedulesPage />
            </DCArtboard>
          </DCSection>
        )}

        {show('agents') && (
          <DCSection id="agents" title="Agents"
            subtitle="The registry of configured agents. Each row is a persona: SDK + model + effort + instructions + skills + tool allowlists. The executor/reviewer dropdowns on tasks pull from here.">
            <DCArtboard id="agents-list" label="Agents list + editor" width={1440} height={900}>
              <AgentsPage />
            </DCArtboard>
          </DCSection>
        )}

        {show('skills') && (
          <DCSection id="skills" title="Skills"
            subtitle="Reusable playbooks. Agents inherit the enabled set by default, or carry an explicit allowlist. Always-on skills inject on every run; matched skills fire when their trigger hits.">
            <DCArtboard id="skills-list" label="Skills list + editor" width={1440} height={900}>
              <SkillsPage />
            </DCArtboard>
          </DCSection>
        )}

        {show('knowledge') && (
          <DCSection id="knowledge" title="Knowledge base"
            subtitle="Shared context any agent can retrieve. Reference entries from a task or from instructions with #slug. Pinned entries surface first; each entry shows which tasks and agents rely on it.">
            <DCArtboard id="kb-list" label="Knowledge base · list + entry" width={1440} height={900}>
              <KnowledgePage />
            </DCArtboard>
          </DCSection>
        )}
      </DesignCanvas>
      <TweaksPanel tweaks={tweaks} setTweaks={setTweaks} visible={editMode} />
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(<App />);
