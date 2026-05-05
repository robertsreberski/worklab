// Scheduled lead-cycle trigger. Polls every TICK_MS; for each active team
// with schedule_enabled=1 and schedule_interval_minutes due, enqueues a
// lead-cycle run for each project the team is assigned to. The watcher's
// in-flight gate (hasInFlightLeadCycle) collapses overlapping schedules so
// nothing piles up — see plan §"Lead-cycle pile-up".

import { listProjectsForTeam, listTeams } from "../core/db/queries/teams.js";
import { getLastLeadCycleAt, hasInFlightLeadCycle } from "../core/db/queries/teams.js";

const TICK_MS = 60_000;

export function createTeamLeadCron({ db, watcher, logger } = {}) {
  let interval = null;

  function intervalMs(team) {
    const minutes = Number(team.schedule_interval_minutes || 0);
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return minutes * 60 * 1000;
  }

  function tick(now = Date.now()) {
    let teams = [];
    try {
      teams = listTeams(db, {
        filters: ["t.status = 'active'", "t.schedule_enabled = 1", "t.schedule_interval_minutes IS NOT NULL"],
        params: [],
        limit: 1000,
      });
    } catch (err) {
      logger?.warn?.({ err: err.message }, "team-lead-cron list failed");
      return;
    }
    for (const team of teams) {
      const cap = intervalMs(team);
      if (!cap) continue;
      const projects = listProjectsForTeam(db, team.id).filter((p) => !p.archived);
      if (!projects.length) continue;
      for (const project of projects) {
        try {
          if (hasInFlightLeadCycle(db, { teamId: team.id, projectId: project.id })) continue;
          const lastAt = getLastLeadCycleAt(db, { teamId: team.id, projectId: project.id });
          if (lastAt && now - lastAt < cap) continue;
          const result = watcher?.spawnLeadCycle?.({
            teamId: team.id,
            projectId: project.id,
            reason: "scheduled",
          });
          if (result && !result.ok && result.skipped !== "in_flight") {
            logger?.warn?.({ teamId: team.id, projectId: project.id, err: result.error }, "scheduled lead cycle skipped");
          }
        } catch (err) {
          logger?.warn?.({ err: err.message, teamId: team.id, projectId: project.id }, "scheduled lead cycle threw");
        }
      }
    }
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => tick(), TICK_MS);
    if (typeof interval.unref === "function") interval.unref();
  }

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  return { start, stop, tick };
}
