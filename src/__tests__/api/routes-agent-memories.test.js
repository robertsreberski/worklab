import { describe, expect, it } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";
import { recordAgentMemoryCandidates } from "../../core/agent-learning.js";

function seedAgent(db, name = "coder") {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', ?, ?)
  `).run(name, name, now, now);
}

describe("agent learning memory routes", () => {
  it("lists and updates structured memories for an agent", async () => {
    const { agent, db } = makeTestServer();
    seedAgent(db);
    const recorded = recordAgentMemoryCandidates(db, {
      agentName: "coder",
      autoApproveThreshold: 0.95,
      candidates: [
        { kind: "procedure", content: "Review API contracts before UI changes.", confidence: 0.8, evidence: "Run r1" },
      ],
    });

    const list = await agent.get("/api/agents/coder/memories").expect(200);
    expect(list.body.memories).toHaveLength(1);
    expect(list.body.memories[0]).toMatchObject({
      id: recorded.memories[0].id,
      status: "draft",
      content: "Review API contracts before UI changes.",
    });

    const patched = await agent
      .patch(`/api/agents/coder/memories/${recorded.memories[0].id}`)
      .send({ status: "approved", evidence: "Human approved." })
      .expect(200);
    expect(patched.body.memory).toMatchObject({
      status: "approved",
      evidence: "Human approved.",
    });
  });

  it("returns bounded learning memory lists with summary metadata", async () => {
    const { agent, db } = makeTestServer();
    seedAgent(db);
    recordAgentMemoryCandidates(db, {
      agentName: "coder",
      autoApproveThreshold: 0.5,
      candidates: [
        { kind: "procedure", content: "Review API contracts before UI changes.", confidence: 0.9, evidence: "Run r1" },
        { kind: "fact", content: "Keep learning rows narrow.", confidence: 0.9, evidence: "Run r2" },
        { kind: "decision", content: "Use summary counts from the API.", confidence: 0.9, evidence: "Run r3" },
      ],
    });

    const list = await agent.get("/api/agents/coder/memories?limit=2").expect(200);

    expect(list.body.memories).toHaveLength(2);
    expect(list.body.summary).toMatchObject({
      total: 3,
      active: 3,
      draft: 0,
      approved: 3,
      archived: 0,
    });
    expect(list.body.meta).toMatchObject({
      limit: 2,
      returned: 2,
      has_more: true,
    });
  });

  it("rejects memory operations for missing agents and invalid statuses", async () => {
    const { agent, db } = makeTestServer();
    seedAgent(db);
    const recorded = recordAgentMemoryCandidates(db, {
      agentName: "coder",
      candidates: [{ kind: "fact", content: "Valid memory.", confidence: 1 }],
    });

    await agent.get("/api/agents/missing/memories").expect(404);
    await agent
      .patch(`/api/agents/coder/memories/${recorded.memories[0].id}`)
      .send({ status: "published" })
      .expect(400);
  });
});
