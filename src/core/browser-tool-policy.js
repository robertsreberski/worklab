import { resolve } from "node:path";

function compactIdentity(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function matchesKnownBrowserToolIdentity(...values) {
  return values.some((value) => {
    const compact = compactIdentity(value);
    return compact.includes("playwright") || compact.includes("browseruse");
  });
}

function isKnownBrowserSkill(skill = {}) {
  return matchesKnownBrowserToolIdentity(skill.name, skill.display_name, skill.trigger);
}

function isKnownBrowserMcpServer(name) {
  return matchesKnownBrowserToolIdentity(name);
}

function shouldRestrictBrowserTools(agent, mode) {
  return mode === "execute" && Boolean(Number(agent?.browser_tools_review_only || 0));
}

function perSkillAccessDirs(skills = []) {
  return [...new Set(
    skills
      .map((skill) => typeof skill?.assetsPath === "string" && skill.assetsPath ? resolve(skill.assetsPath) : "")
      .filter(Boolean),
  )];
}

export function applyBrowserToolsReviewOnlyPolicy({
  agent,
  mode,
  skills = [],
  mcpServers = {},
} = {}) {
  if (!shouldRestrictBrowserTools(agent, mode)) {
    return {
      skills,
      mcpServers,
      skillDirs: undefined,
      capabilityRestrictions: {
        browserToolsReviewOnly: false,
        suppressedSkills: [],
        suppressedMcpServers: [],
      },
    };
  }

  const suppressedSkills = [];
  const allowedSkills = [];
  for (const skill of skills || []) {
    if (isKnownBrowserSkill(skill)) {
      suppressedSkills.push(skill.name);
    } else {
      allowedSkills.push(skill);
    }
  }

  const suppressedMcpServers = [];
  const allowedMcpServers = {};
  for (const [name, server] of Object.entries(mcpServers || {})) {
    if (isKnownBrowserMcpServer(name)) {
      suppressedMcpServers.push(name);
    } else {
      allowedMcpServers[name] = server;
    }
  }

  return {
    skills: allowedSkills,
    mcpServers: allowedMcpServers,
    skillDirs: perSkillAccessDirs(allowedSkills),
    capabilityRestrictions: {
      browserToolsReviewOnly: true,
      suppressedSkills,
      suppressedMcpServers,
    },
  };
}
