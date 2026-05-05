// §6.x Teams — minimal pane layout. List teams, edit roster/goal/budget,
// view recent lead cycles, and trigger a manual run-lead. Reuses the
// PaneLayout pattern from Agents/Projects.

import { useEffect, useMemo, useState, useCallback, useRef } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useThrottledCallback } from "../lib/useThrottledCallback.js";
import { useAppResume } from "../lib/pageVisibility.js";
import { AppShell } from "../components/AppShell.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Icon } from "../components/Icon.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { PaneListHeader } from "../components/layout/index.js";
import { EmptyState } from "../components/EmptyState.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { Card } from "../components/Card.jsx";
import { Badge } from "../components/primitives/Badge.jsx";
import { AgentPicker } from "../components/AgentPicker.jsx";
import { navigateHash } from "../lib/navigation.js";
import { pushToast } from "../lib/toast.js";

const GOOD_TEAM_CHECKLIST = [
  "Goal: define the kind of work this team owns.",
  "Lead: pick a coordinator/orchestrator who can triage and delegate.",
  "Members: add 2-5 specialists with distinct strengths.",
  "Roles: describe when each member should be used.",
  "Assignment: attach the team to a project, or override per task.",
  "Controls: start manual, then add schedules/budgets once the roster works.",
];

function teamDraftFrom(team, members = []) {
  return {
    name: team?.name || "",
    slug: team?.slug || "",
    description: team?.description || "",
    goal: team?.goal || "",
    lead_agent: team?.lead_agent || "",
    status: team?.status || "active",
    schedule_enabled: !!team?.schedule_enabled,
    schedule_interval_minutes: team?.schedule_interval_minutes ?? null,
    daily_budget_usd: team?.daily_budget_usd ?? null,
    per_run_budget_usd: team?.per_run_budget_usd ?? null,
    members: Array.isArray(members) ? members.map((m) => ({
      agent_name: m.agent_name,
      role_description: m.role_description || "",
    })) : [],
  };
}

function intervalDisplay(value) {
  if (!value) return "—";
  return `${value} min`;
}

function statusTone(status) {
  return status === "archived" ? "muted" : "primary";
}

function relativeTime(ts) {
  if (!ts) return "—";
  const ms = Date.now() - Number(ts);
  if (ms < 0) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function teamSetupGaps(team = {}, members = [], projects = []) {
  const gaps = [];
  if (!String(team?.goal || "").trim()) {
    gaps.push("Add a goal so the lead knows what work this team owns.");
  }
  if (!String(team?.lead_agent || "").trim()) {
    gaps.push("Pick a lead agent to coordinate and delegate.");
  }
  if (!Array.isArray(members) || members.length === 0) {
    gaps.push("Add member agents with distinct specialties.");
  }
  if (!Array.isArray(projects) || projects.length === 0) {
    gaps.push("Assign the team to a project or task when it is ready.");
  }
  return gaps;
}

function TeamSetupGuide() {
  return (
    <Card title="Good team checklist" class="team-setup-card">
      <p class="team-setup-intro">
        Build a small roster around a clear goal. Let the lead coordinate work; use members for specialist execution and review.
      </p>
      <ul class="team-setup-list">
        {GOOD_TEAM_CHECKLIST.map((item) => (
          <li key={item} class="team-setup-item">
            <Icon name="check-circle" size={13} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TeamSetupGapsCard({ gaps }) {
  if (!gaps?.length) return null;
  return (
    <Card title="Setup gaps" class="team-setup-card">
      <ul class="team-setup-list">
        {gaps.map((gap) => (
          <li key={gap} class="team-setup-item">
            <Icon name="alert-circle" size={13} />
            <span>{gap}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MembersEditor({ members, agents, onChange }) {
  function update(idx, patch) {
    const next = members.slice();
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  }
  function remove(idx) {
    onChange(members.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([...members, { agent_name: "", role_description: "" }]);
  }
  return (
    <div class="team-members-editor">
      {members.length === 0 && (
        <p class="muted">No members yet. Add at least one (the lead is implicitly part of the roster).</p>
      )}
      {members.map((m, idx) => (
        <div class="team-member-row" key={idx}>
          <AgentPicker
            value={m.agent_name || ""}
            onChange={(agentName) => update(idx, { agent_name: agentName || "" })}
            agents={agents}
            placeholder="Pick a member"
            ariaLabel="Team member agent"
          />
          <Input
            value={m.role_description}
            onInput={(e) => update(idx, { role_description: e.currentTarget.value })}
            placeholder="role / responsibility"
          />
          <Button variant="ghost" onClick={() => remove(idx)}>Remove</Button>
        </div>
      ))}
      <Button variant="secondary" onClick={add} iconLeft={<Icon name="plus" size={13} />}>Add member</Button>
    </div>
  );
}

function TeamEditor({ team, members, agents, onSaved, isNew }) {
  const [draft, setDraft] = useState(teamDraftFrom(team, members));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { setDraft(teamDraftFrom(team, members)); }, [team?.id, members?.length]);

  function update(patch) {
    setDraft((cur) => ({ ...cur, ...patch }));
  }

  async function save() {
    if (!draft.name.trim()) {
      pushToast("Team name is required", { variant: "error" });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        slug: draft.slug.trim() || undefined,
        description: draft.description,
        goal: draft.goal,
        lead_agent: String(draft.lead_agent || "").trim() || null,
        status: draft.status,
        schedule_enabled: !!draft.schedule_enabled,
        schedule_interval_minutes: draft.schedule_interval_minutes,
        daily_budget_usd: draft.daily_budget_usd,
        per_run_budget_usd: draft.per_run_budget_usd,
        members: draft.members
          .map((m) => ({
            ...m,
            agent_name: String(m.agent_name || "").trim(),
          }))
          .filter((m) => m.agent_name),
      };
      let saved;
      if (isNew) {
        saved = await api.createTeam(payload);
      } else {
        saved = await api.patchTeam(team.id, payload);
      }
      pushToast(isNew ? "Team created" : "Team saved", { variant: "success" });
      onSaved?.(saved.team);
      if (isNew) navigateHash(`#/teams/${encodeURIComponent(saved.team.slug)}`);
    } catch (err) {
      setError(err.message || "Save failed");
      pushToast(`Save failed: ${err.message}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="entity-editor-main" style={{ padding: "1rem" }}>
      {error && <p class="error">{error}</p>}
      <TeamSetupGuide />
      <Card title="Team">
        <div style={{ display: "grid", gap: "0.75rem" }}>
          <label>Name<Input value={draft.name} onInput={(e) => update({ name: e.currentTarget.value })} /></label>
          <label>Slug<Input value={draft.slug} onInput={(e) => update({ slug: e.currentTarget.value })} placeholder="generated-from-name" /></label>
          <label>Description<Input value={draft.description} onInput={(e) => update({ description: e.currentTarget.value })} /></label>
          <label>Goal<Textarea rows={4} value={draft.goal} onInput={(e) => update({ goal: e.currentTarget.value })} /></label>
          <label>Lead agent
            <AgentPicker
              value={draft.lead_agent || ""}
              onChange={(agentName) => update({ lead_agent: agentName || "" })}
              agents={agents}
              placeholder="Pick a lead"
              ariaLabel="Team lead agent"
            />
          </label>
        </div>
      </Card>
      <Card title="Members">
        <MembersEditor members={draft.members} agents={agents} onChange={(m) => update({ members: m })} />
      </Card>
      <Card title="Schedule">
        <div style={{ display: "grid", gap: "0.75rem" }}>
          <Switch
            checked={!!draft.schedule_enabled}
            onChange={(v) => update({ schedule_enabled: v })}
            label="Run lead cycles on a schedule"
            description="Periodically fire a worklab.lead_cycle.v1 run for each project this team is assigned to."
          />
          <label>Interval (minutes)
            <Input
              type="number"
              min="1"
              step="1"
              value={draft.schedule_interval_minutes ?? ""}
              placeholder="e.g. 60"
              onInput={(e) => {
                const v = e.currentTarget.value.trim();
                update({ schedule_interval_minutes: v === "" ? null : Number(v) });
              }}
            />
          </label>
        </div>
      </Card>
      <Card title="Budget">
        <div style={{ display: "grid", gap: "0.75rem" }}>
          <label>Daily budget (USD)
            <Input
              type="number"
              min="0"
              step="0.01"
              value={draft.daily_budget_usd ?? ""}
              placeholder="No cap"
              onInput={(e) => {
                const v = e.currentTarget.value.trim();
                update({ daily_budget_usd: v === "" ? null : Number(v) });
              }}
            />
          </label>
          <label>Per-run budget (USD)
            <Input
              type="number"
              min="0"
              step="0.01"
              value={draft.per_run_budget_usd ?? ""}
              placeholder="No cap"
              onInput={(e) => {
                const v = e.currentTarget.value.trim();
                update({ per_run_budget_usd: v === "" ? null : Number(v) });
              }}
            />
          </label>
          <p class="muted">Team budgets replace the retired per-agent budgets. The workspace daily cap (Settings) remains a global ceiling.</p>
        </div>
      </Card>
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        <Button variant="primary" loading={saving} onClick={save}>{isNew ? "Create team" : "Save"}</Button>
        <Button variant="ghost" onClick={() => navigateHash("#/teams")}>Cancel</Button>
      </div>
    </div>
  );
}

function TeamDetail({ team, members, projects, cycles, onChanged }) {
  const [running, setRunning] = useState(false);
  const setupGaps = teamSetupGaps(team, members, projects);
  async function runLeadNow() {
    setRunning(true);
    try {
      const res = await api.runTeamLead(team.id, { reason: "manual" });
      const okCount = (res.results || []).filter((r) => r.ok).length;
      pushToast(`Queued ${okCount} lead cycle${okCount === 1 ? "" : "s"}`, { variant: okCount ? "success" : "warning" });
      onChanged?.();
    } catch (err) {
      pushToast(`Run-lead failed: ${err.message}`, { variant: "error" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ padding: "1rem", display: "grid", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", justifyContent: "space-between" }}>
        <div>
          <h2>{team.name}</h2>
          <p class="muted">{team.slug} — <Badge variant={statusTone(team.status)}>{team.status}</Badge></p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button variant="primary" loading={running} disabled={!team.lead_agent} onClick={runLeadNow}>Run lead now</Button>
          <Button variant="secondary" onClick={() => navigateHash(`#/teams/${encodeURIComponent(team.slug)}/edit`)}>Edit</Button>
        </div>
      </div>
      <Card title="Goal">
        <p>{team.goal || <em>(no goal set)</em>}</p>
      </Card>
      <TeamSetupGapsCard gaps={setupGaps} />
      <Card title={`Roster (${members.length})`}>
        {members.length === 0 ? (
          <p class="muted">No members.</p>
        ) : (
          <ul>
            {members.map((m) => (
              <li key={m.agent_name}>
                <strong>{m.display_name || m.agent_name}</strong>
                {m.role_description ? ` — ${m.role_description}` : null}
                {!m.enabled ? <Badge variant="warn"> disabled </Badge> : null}
              </li>
            ))}
          </ul>
        )}
        <p class="muted">Lead: {team.lead_agent || "(none)"}</p>
      </Card>
      <Card title={`Assigned projects (${projects.length})`}>
        {projects.length === 0 ? (
          <p class="muted">Not assigned to any project yet. Open a project's edit page and set its team.</p>
        ) : (
          <ul>
            {projects.map((p) => (
              <li key={p.id}>
                <a href={`#/projects/${encodeURIComponent(p.slug)}`}>{p.name}</a> ({p.slug})
                {p.archived ? <Badge variant="muted"> archived </Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Recent lead cycles (${cycles.length})`}>
        {cycles.length === 0 ? (
          <p class="muted">No cycles yet.</p>
        ) : (
          <ul>
            {cycles.map((c) => (
              <li key={c.id}>
                <span>{relativeTime(c.started_at)}</span>{" "}
                <Badge variant={c.process_status === "succeeded" ? "primary" : c.process_status === "failed" ? "warn" : "muted"}>
                  {c.process_status || c.status}
                </Badge>
                {c.summary ? `: ${c.summary}` : ""}
                {c.cost_usd ? <span class="muted"> ${Number(c.cost_usd).toFixed(4)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Schedule">
        <p>{team.schedule_enabled ? `Auto-running every ${intervalDisplay(team.schedule_interval_minutes)}` : "Off (lead runs only on task completions or manual trigger)"}</p>
      </Card>
      <Card title="Budget">
        <p>Daily: {team.daily_budget_usd ? `$${Number(team.daily_budget_usd).toFixed(2)}` : "(no cap)"} · Per-run: {team.per_run_budget_usd ? `$${Number(team.per_run_budget_usd).toFixed(2)}` : "(no cap)"}</p>
      </Card>
    </div>
  );
}

function emptyState() {
  return (
    <EmptyState
      icon={<Icon name="users" size={20} />}
      title="No team selected"
      body="Create a team, choose a lead, add specialist members, then assign it to a project or task."
    />
  );
}

export function Teams({ selectedId = null, mode = null }) {
  const [teams, setTeams] = useState([]);
  const [agents, setAgents] = useState([]);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState(null);
  const reloadRef = useRef(null);
  const agentsReloadRef = useRef(null);

  const reload = useCallback(() => {
    reloadRef.current?.abort?.();
    const ctrl = new AbortController();
    reloadRef.current = ctrl;
    api.listTeams(undefined, { signal: ctrl.signal })
      .then((r) => { if (!ctrl.signal.aborted) setTeams(r.teams || []); })
      .catch((err) => { if (err?.name !== "AbortError") setTeams([]); });
  }, []);
  const reloadSoon = useThrottledCallback(reload, 100);

  const reloadAgents = useCallback(() => {
    agentsReloadRef.current?.abort?.();
    const ctrl = new AbortController();
    agentsReloadRef.current = ctrl;
    api.listAgents({ signal: ctrl.signal })
      .then((r) => { if (!ctrl.signal.aborted) setAgents(r.agents || []); })
      .catch((err) => { if (err?.name !== "AbortError") setAgents([]); });
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { reloadAgents(); }, [reloadAgents]);
  useEffect(() => () => {
    reloadRef.current?.abort?.();
    agentsReloadRef.current?.abort?.();
  }, []);
  useSSE("global", (evt) => {
    if (typeof evt?.type === "string" && (evt.type.startsWith("team_") || evt.type.startsWith("lead_cycle_"))) {
      reloadSoon();
      if (selectedId && (evt.id === selectedId || evt.slug === selectedId || evt.team_id === selectedId)) {
        loadDetail();
      }
    }
  });
  useAppResume(reloadSoon);
  useAppResume(reloadAgents);

  const loadDetail = useCallback(() => {
    if (!selectedId || selectedId === "new") { setDetail(null); return; }
    api.getTeam(selectedId).then(setDetail).catch(() => setDetail(null));
  }, [selectedId]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((t) => (t.name + " " + t.slug + " " + (t.goal || "")).toLowerCase().includes(q));
  }, [teams, query]);

  const isNew = selectedId === "new";
  const isEditing = mode === "edit" || isNew;

  let body;
  if (isNew) {
    body = (
      <TeamEditor
        team={null}
        members={[]}
        agents={agents}
        isNew
        onSaved={() => { reload(); }}
      />
    );
  } else if (selectedId) {
    if (!detail) {
      body = <EmptyState icon={<Icon name="users" size={20} />} title="Loading..." body="" />;
    } else if (isEditing) {
      body = (
        <TeamEditor
          team={detail.team}
          members={detail.members || []}
          agents={agents}
          onSaved={() => { reload(); loadDetail(); }}
        />
      );
    } else {
      body = (
        <TeamDetail
          team={detail.team}
          members={detail.members || []}
          projects={detail.projects || []}
          cycles={detail.recent_cycles || []}
          onChanged={() => { reload(); loadDetail(); }}
        />
      );
    }
  } else {
    body = emptyState();
  }

  return (
    <AppShell>
      <PaneLayout
        hasSelection={!!selectedId}
        onBack={() => navigateHash("#/teams")}
        backLabel="Teams"
        listHeader={(
          <PaneListHeader
            searchValue={query}
            onSearch={setQuery}
            searchPlaceholder="Search teams..."
            searchAriaLabel="Search teams"
            actionLabel="New team"
            onAction={() => navigateHash("#/teams/new")}
          />
        )}
        listBody={(
          <div class="pane-list">
            {filtered.length === 0 ? (
              <EmptyState
                icon={<Icon name="users" size={20} />}
                title="No teams"
                body="Create a team, choose a lead, add specialist members, then assign it to a project or task."
              />
            ) : filtered.map((team) => (
              <PaneRow
                key={team.id}
                active={team.id === selectedId || team.slug === selectedId}
                href={`#/teams/${encodeURIComponent(team.slug)}`}
                title={team.name}
                sub={<><span>{team.slug}</span> · <span>{team.member_count ?? 0} member{(team.member_count ?? 0) === 1 ? "" : "s"}</span></>}
                trailing={<Badge variant={statusTone(team.status)}>{team.status}</Badge>}
              />
            ))}
          </div>
        )}
        detail={body}
      />
    </AppShell>
  );
}
