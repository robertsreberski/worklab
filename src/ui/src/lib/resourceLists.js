import { externalAgentKind } from "./externalAgents.js";

const RECENT_AGENT_MS = 10 * 60_000;

function timestamp(value) {
  if (typeof value === "number") return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value) {
  return String(value || "").trim();
}

function labelize(value, fallback = "Uncategorized") {
  const raw = text(value) || fallback;
  return raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function matchesQuery(parts, query) {
  const q = text(query).toLowerCase();
  if (!q) return true;
  return parts.some((part) => text(part).toLowerCase().includes(q));
}

function compareByLabel(left, right, labelOf) {
  return text(labelOf(left)).localeCompare(text(labelOf(right)), undefined, { sensitivity: "base" });
}

function compareText(left, right) {
  return text(left).localeCompare(text(right), undefined, { sensitivity: "base" });
}

function groupFrom(items, definitions, classifier) {
  const buckets = new Map(definitions.map((definition) => [definition.key, { ...definition, items: [] }]));
  for (const item of items) {
    const key = classifier(item);
    const group = buckets.get(key);
    if (group) group.items.push(item);
  }
  return definitions.map((definition) => buckets.get(definition.key)).filter((group) => group.items.length > 0);
}

export function agentIsRecent(agent, now = Date.now()) {
  const lastRun = timestamp(agent?.lastRunAt ?? agent?.last_run_at);
  return lastRun > 0 && now - lastRun < RECENT_AGENT_MS;
}

export function buildAgentResourceGroups(agents = [], {
  query = "",
  state = "all",
  activity = "all",
  kind = "all",
  model = "all",
  effort = "all",
  now = Date.now(),
} = {}) {
  const items = (agents || [])
    .filter((agent) => {
      const enabled = agent?.enabled !== false;
      const recent = agentIsRecent(agent, now);
      if (kind !== "all" && externalAgentKind(agent) !== kind) return false;
      if (state === "enabled" && !enabled) return false;
      if (state === "disabled" && enabled) return false;
      if (activity === "recent" && !recent) return false;
      if (activity === "idle" && recent) return false;
      if (model !== "all" && agent?.model !== model) return false;
      if (effort !== "all" && (agent?.effort || "") !== effort) return false;
      return matchesQuery([agent?.name, agent?.display_name, agent?.description, agent?.model, agent?.effort, agent?.context_window, agent?.driver, agent?.external_driver], query);
    })
    .sort((left, right) => {
      const leftRecent = agentIsRecent(left, now);
      const rightRecent = agentIsRecent(right, now);
      if (leftRecent !== rightRecent) return leftRecent ? -1 : 1;
      if ((left.enabled !== false) !== (right.enabled !== false)) return left.enabled !== false ? -1 : 1;
      return compareByLabel(left, right, (agent) => agent.display_name || agent.name);
    });

  return groupFrom(items, [
    { key: "active", label: "Active now" },
    { key: "enabled", label: "Enabled" },
    { key: "disabled", label: "Disabled" },
  ], (agent) => {
    if (agentIsRecent(agent, now)) return "active";
    return agent.enabled === false ? "disabled" : "enabled";
  });
}

export function buildTeamResourceGroups(teams = [], {
  query = "",
  status = "active",
  schedule = "all",
  lead = "all",
} = {}) {
  const items = (teams || [])
    .filter((team) => {
      const teamStatus = team?.status || "active";
      if (status !== "all" && teamStatus !== status) return false;
      if (schedule === "scheduled" && !team?.schedule_enabled) return false;
      if (schedule === "manual" && team?.schedule_enabled) return false;
      if (lead === "with_lead" && !team?.lead_agent) return false;
      if (lead === "no_lead" && team?.lead_agent) return false;
      return matchesQuery([team?.name, team?.slug, team?.description, team?.goal, team?.lead_agent], query);
    })
    .sort((left, right) => {
      if ((left.status || "active") !== (right.status || "active")) return (left.status || "active") === "active" ? -1 : 1;
      const updated = timestamp(right.updated_at) - timestamp(left.updated_at);
      if (updated !== 0) return updated;
      return compareByLabel(left, right, (team) => team.name || team.slug);
    });

  return groupFrom(items, [
    { key: "active", label: "Active" },
    { key: "archived", label: "Archived" },
  ], (team) => team.status === "archived" ? "archived" : "active");
}

function projectTeamLabel(project) {
  return project?.team?.name || project?.team_name || "";
}

export function buildProjectResourceGroups(projects = [], {
  query = "",
  status = "active",
  worktree = "all",
  team = "all",
} = {}) {
  const items = (projects || [])
    .filter((project) => {
      const archived = !!project?.archived;
      const worktreeMode = project?.worktree_mode || "off";
      const teamId = project?.team_id || "";
      if (status === "active" && archived) return false;
      if (status === "archived" && !archived) return false;
      if (worktree !== "all" && worktreeMode !== worktree) return false;
      if (team === "no_team" && teamId) return false;
      if (team !== "all" && team !== "no_team" && teamId !== team) return false;
      return matchesQuery([
        project?.name,
        project?.slug,
        project?.description,
        project?.context,
        project?.workdir,
        project?.team_id,
        project?.team?.slug,
        projectTeamLabel(project),
        ...(project?.tags || []),
      ], query);
    })
    .sort((left, right) => {
      if (!!left.archived !== !!right.archived) return left.archived ? 1 : -1;
      const updated = timestamp(right.updated_at) - timestamp(left.updated_at);
      if (updated !== 0) return updated;
      return compareByLabel(left, right, (project) => project.name || project.slug);
    });

  return groupFrom(items, [
    { key: "active", label: "Active" },
    { key: "archived", label: "Archived" },
  ], (project) => project.archived ? "archived" : "active");
}

function knowledgeProjectLabel(entry) {
  return entry?.project?.name || (entry?.project_id ? "Unknown Project" : "Global");
}

function knowledgeCategory(entry) {
  return entry?.display_category || entry?.category || "";
}

function knowledgeIsRunOutput(entry) {
  return !!(entry?.run_output || entry?.auto_promoted);
}

const DEFAULT_KNOWLEDGE_SORT = "pinned_first";
const KNOWLEDGE_SORT_MODES = new Set(["updated_desc", DEFAULT_KNOWLEDGE_SORT, "title_asc", "project_category"]);

function knowledgeSortMode(sort) {
  return KNOWLEDGE_SORT_MODES.has(sort) ? sort : DEFAULT_KNOWLEDGE_SORT;
}

function knowledgeEntryTimestamp(entry) {
  return timestamp(entry?.updated_at) || timestamp(entry?.created_at);
}

function compareKnowledgeTitle(left, right) {
  const title = compareText(left?.title || left?.slug, right?.title || right?.slug);
  if (title !== 0) return title;
  return compareText(left?.slug, right?.slug);
}

function compareKnowledgeRecent(left, right) {
  const updated = knowledgeEntryTimestamp(right) - knowledgeEntryTimestamp(left);
  if (updated !== 0) return updated;
  return compareKnowledgeTitle(left, right);
}

function compareKnowledgePinned(left, right) {
  if (!!left?.pinned !== !!right?.pinned) return left?.pinned ? -1 : 1;
  return compareKnowledgeRecent(left, right);
}

function sortKnowledgeItems(items, sort) {
  const mode = knowledgeSortMode(sort);
  if (mode === "pinned_first") return [...items].sort(compareKnowledgePinned);
  if (mode === "title_asc") return [...items].sort(compareKnowledgeTitle);
  return [...items].sort(compareKnowledgeRecent);
}

function flatKnowledgeGroup(items, sort, surface = "artifacts") {
  if (!items.length) return [];
  if (surface === "artifacts") {
    return [{
      key: "artifacts",
      label: "Artifacts",
      showHeader: false,
      items: sortKnowledgeItems(items, sort),
    }];
  }
  const mode = knowledgeSortMode(sort);
  const labels = {
    updated_desc: "Recent updates",
    pinned_first: "Pinned first",
    title_asc: "Title A-Z",
  };
  const keys = {
    updated_desc: "recent",
    pinned_first: "pinned-first",
    title_asc: "title",
  };
  return [{
    key: keys[mode] || "recent",
    label: labels[mode] || "Recent updates",
    items: sortKnowledgeItems(items, mode),
  }];
}

export function buildKnowledgeResourceGroups(entries = [], {
  query = "",
  projectId = "all",
  category = "all",
  subcategory = "all",
  tag = "all",
  pinned = "all",
  surface = "artifacts",
  sort = DEFAULT_KNOWLEDGE_SORT,
} = {}) {
  const mode = knowledgeSortMode(sort);
  const items = [];
  const groups = new Map();
  for (const entry of entries || []) {
    if (projectId !== "all" && (entry.project_id || "") !== projectId) continue;
    const categoryValue = knowledgeCategory(entry);
    const isRunOutput = knowledgeIsRunOutput(entry);
    if (category !== "all" && categoryValue !== category) continue;
    if (subcategory !== "all" && (entry.subcategory || "") !== subcategory) continue;
    if (tag !== "all" && !(entry.tags || []).includes(tag)) continue;
    if (pinned === "pinned" && !entry.pinned) continue;
    if (pinned === "unpinned" && entry.pinned) continue;
    if ((surface === "artifacts" || surface === "canonical") && isRunOutput) continue;
    if (surface === "run_outputs" && !isRunOutput) continue;
    if (!matchesQuery([
      entry.title,
      entry.slug,
      entry.project?.name,
      entry.project?.slug,
      categoryValue,
      entry.subcategory,
      ...(entry.tags || []),
    ], query)) continue;
    items.push(entry);
    if (mode !== "project_category") continue;

    const projectLabel = knowledgeProjectLabel(entry);
    const categoryLabel = labelize(categoryValue);
    const key = `${projectLabel}::${categoryLabel}`;
    if (!groups.has(key)) {
      groups.set(key, { key, label: `${projectLabel} / ${categoryLabel}`, projectLabel, categoryLabel, items: [] });
    }
    groups.get(key).items.push(entry);
  }
  if (mode !== "project_category") return flatKnowledgeGroup(items, mode, surface);

  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: sortKnowledgeItems(group.items, "pinned_first"),
    }))
    .sort((left, right) => {
      const leftGlobal = left.projectLabel === "Global";
      const rightGlobal = right.projectLabel === "Global";
      if (leftGlobal !== rightGlobal) return leftGlobal ? 1 : -1;
      const project = left.projectLabel.localeCompare(right.projectLabel, undefined, { sensitivity: "base" });
      if (project !== 0) return project;
      return left.categoryLabel.localeCompare(right.categoryLabel, undefined, { sensitivity: "base" });
    });
}

export function buildSkillResourceGroups(skills = [], {
  query = "",
  state = "all",
  priority = "all",
  usage = "all",
} = {}) {
  const items = (skills || [])
    .filter((skill) => {
      const enabled = skill?.enabled !== false;
      const always = skill?.priority === "always";
      const used = Number(skill?.used_by_count || 0) > 0;
      if (state === "enabled" && !enabled) return false;
      if (state === "disabled" && enabled) return false;
      if (priority === "always" && !always) return false;
      if (priority === "normal" && always) return false;
      if (usage === "used" && !used) return false;
      if (usage === "unused" && used) return false;
      return matchesQuery([skill?.name, skill?.display_name, skill?.trigger], query);
    })
    .sort((left, right) => {
      if ((left.priority === "always") !== (right.priority === "always")) return left.priority === "always" ? -1 : 1;
      if ((left.enabled !== false) !== (right.enabled !== false)) return left.enabled !== false ? -1 : 1;
      return compareByLabel(left, right, (skill) => skill.display_name || skill.name);
    });

  return groupFrom(items, [
    { key: "always", label: "Always" },
    { key: "enabled", label: "Enabled" },
    { key: "disabled", label: "Disabled" },
  ], (skill) => {
    if (skill.priority === "always") return "always";
    return skill.enabled === false ? "disabled" : "enabled";
  });
}

export function buildProviderResourceGroups(providers = [], {
  query = "",
  state = "all",
  type = "all",
} = {}) {
  const items = (providers || [])
    .filter((provider) => {
      const enabled = provider?.enabled !== false;
      if (state === "enabled" && !enabled) return false;
      if (state === "disabled" && enabled) return false;
      if (type !== "all" && provider?.provider_type !== type) return false;
      return matchesQuery([provider?.name, provider?.base_url, provider?.provider_type], query);
    })
    .sort((left, right) => {
      if ((left.enabled !== false) !== (right.enabled !== false)) return left.enabled !== false ? -1 : 1;
      const updated = timestamp(right.updated_at) - timestamp(left.updated_at);
      if (updated !== 0) return updated;
      return compareByLabel(left, right, (provider) => provider.name || provider.id);
    });

  return groupFrom(items, [
    { key: "enabled", label: "Enabled" },
    { key: "disabled", label: "Disabled" },
  ], (provider) => provider.enabled === false ? "disabled" : "enabled");
}

export function flattenResourceGroups(groups = []) {
  return (groups || []).flatMap((group) => group.items || []);
}
