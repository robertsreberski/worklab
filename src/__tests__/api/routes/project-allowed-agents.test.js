// R9 — API surface for the per-project agent allowlist.
//
// Asserts that `allowed_agents` and `delegation_allow_unlisted` flow through
// POST /api/projects + PATCH /api/projects/:id and round-trip via GET. The
// shape mirrors the watcher's enforcement contract (`benchmark-*` glob
// patterns, empty array == "any agent", boolean override flag).

import { describe, expect, it } from "vitest";
import { makeTestServer } from "../../helpers/test-server.js";

describe("project allowed_agents API", () => {
  it("creates a project with allowed_agents + delegation_allow_unlisted", async () => {
    const { agent } = makeTestServer();

    const response = await agent.post("/api/projects").send({
      name: "Audit Period",
      allowed_agents: ["benchmark-*", "qa-runner"],
      delegation_allow_unlisted: false,
    }).expect(201);

    expect(response.body.project).toMatchObject({
      slug: "audit-period",
      allowed_agents: ["benchmark-*", "qa-runner"],
      delegation_allow_unlisted: false,
    });
  });

  it("defaults allowed_agents to empty array when omitted", async () => {
    const { agent } = makeTestServer();

    const response = await agent.post("/api/projects").send({
      name: "Default Allowlist",
    }).expect(201);

    expect(response.body.project.allowed_agents).toEqual([]);
    expect(response.body.project.delegation_allow_unlisted).toBe(false);
  });

  it("accepts array input directly without wrapping in JSON", async () => {
    const { agent } = makeTestServer();

    const response = await agent.post("/api/projects").send({
      name: "Direct Array",
      allowed_agents: ["benchmark-*"],
    }).expect(201);

    expect(response.body.project.allowed_agents).toEqual(["benchmark-*"]);
  });

  it("dedupes and trims allowed_agents on create", async () => {
    const { agent } = makeTestServer();

    const response = await agent.post("/api/projects").send({
      name: "Dedupe",
      allowed_agents: ["benchmark-*", "  benchmark-*  ", "qa-runner", ""],
    }).expect(201);

    expect(response.body.project.allowed_agents).toEqual(["benchmark-*", "qa-runner"]);
  });

  it("PATCH updates allowed_agents + delegation_allow_unlisted in isolation", async () => {
    const { agent } = makeTestServer();
    const created = await agent.post("/api/projects").send({ name: "Patch Target" }).expect(201);
    const id = created.body.project.id;

    const allowed = await agent.patch(`/api/projects/${id}`).send({
      allowed_agents: ["benchmark-*"],
    }).expect(200);
    expect(allowed.body.project).toMatchObject({
      allowed_agents: ["benchmark-*"],
      delegation_allow_unlisted: false,
    });

    const override = await agent.patch(`/api/projects/${id}`).send({
      delegation_allow_unlisted: true,
    }).expect(200);
    expect(override.body.project).toMatchObject({
      allowed_agents: ["benchmark-*"],
      delegation_allow_unlisted: true,
    });

    const cleared = await agent.patch(`/api/projects/${id}`).send({
      allowed_agents: [],
    }).expect(200);
    expect(cleared.body.project.allowed_agents).toEqual([]);
  });

  it("PATCH with allowed_agents: null clears the list", async () => {
    const { agent } = makeTestServer();
    const created = await agent.post("/api/projects").send({
      name: "Null Clears",
      allowed_agents: ["benchmark-*"],
    }).expect(201);
    const id = created.body.project.id;

    const cleared = await agent.patch(`/api/projects/${id}`).send({
      allowed_agents: null,
    }).expect(200);
    expect(cleared.body.project.allowed_agents).toEqual([]);
  });

  it("GET round-trips both fields", async () => {
    const { agent } = makeTestServer();
    const created = await agent.post("/api/projects").send({
      name: "Round Trip",
      allowed_agents: ["benchmark-*"],
      delegation_allow_unlisted: true,
    }).expect(201);

    const detail = await agent.get(`/api/projects/${created.body.project.id}`).expect(200);
    expect(detail.body.project).toMatchObject({
      allowed_agents: ["benchmark-*"],
      delegation_allow_unlisted: true,
    });
  });

  it("ignores delegation_allow_unlisted values that are not strictly true", async () => {
    const { agent } = makeTestServer();
    const created = await agent.post("/api/projects").send({
      name: "Coerced",
      delegation_allow_unlisted: "true",
    }).expect(201);
    expect(created.body.project.delegation_allow_unlisted).toBe(false);

    const patched = await agent.patch(`/api/projects/${created.body.project.id}`).send({
      delegation_allow_unlisted: 1,
    }).expect(200);
    expect(patched.body.project.delegation_allow_unlisted).toBe(false);
  });
});
