import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

const dirs = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("task attachments API", () => {
  it("stores path attachments on task instructions and comments", async () => {
    const workdir = makeTempDir("worklab-attachments-workdir-");
    const dataDir = makeTempDir("worklab-attachments-data-");
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "brief.md"), "# Brief\n");
    const { agent } = makeTestServer({
      dataDir,
      config: { dataDir, repoRoot: workdir, workspace: workdir },
    });

    const created = await agent.post("/api/tasks").send({
      title: "Attachment task",
      instructions: "Read the attached brief.",
      attachments: [{ kind: "path", path: "src/brief.md", label: "Brief" }],
    }).expect(201);

    expect(created.body.task.attachments).toHaveLength(1);
    expect(created.body.task.attachments[0]).toMatchObject({
      kind: "path",
      owner_type: "task_instructions",
      path_text: "src/brief.md",
      label: "Brief",
    });
    expect(created.body.task.attachments[0].absolute_path).toBe(join(workdir, "src", "brief.md"));

    await agent.post(`/api/tasks/${created.body.task.id}/comments`).send({
      body: "Use the screenshot path too.",
      rerun: false,
      attachments: [{ kind: "path", path: "/tmp/worklab-shot.png" }],
    }).expect(201);

    const detail = await agent.get(`/api/tasks/${created.body.task.id}`).expect(200);
    expect(detail.body.task.attachments).toHaveLength(1);
    expect(detail.body.comments[0].attachments).toHaveLength(1);
    expect(detail.body.comments[0].attachments[0]).toMatchObject({
      kind: "path",
      owner_type: "comment",
      path_text: "/tmp/worklab-shot.png",
      absolute_path: "/tmp/worklab-shot.png",
    });
  });

  it("saves pasted image uploads into Worklab attachment storage", async () => {
    const workdir = makeTempDir("worklab-upload-workdir-");
    const dataDir = makeTempDir("worklab-upload-data-");
    const { agent } = makeTestServer({
      dataDir,
      config: { dataDir, repoRoot: workdir, workspace: workdir },
    });
    const png = Buffer.from("89504e470d0a1a0a", "hex");

    const upload = await agent
      .post("/api/attachments/uploads")
      .set("Content-Type", "image/png")
      .set("X-Attachment-Filename", "clip.png")
      .send(png)
      .expect(201);

    const created = await agent.post("/api/tasks").send({
      title: "Image task",
      attachments: [{ kind: "upload", upload_id: upload.body.upload.id, label: "Clipboard image" }],
    }).expect(201);

    const attachment = created.body.task.attachments[0];
    expect(attachment).toMatchObject({
      kind: "upload",
      source: "pasted_image",
      label: "Clipboard image",
      filename: "clip.png",
      mime_type: "image/png",
      size_bytes: png.length,
    });
    expect(attachment.href).toBe(`/api/tasks/${created.body.task.id}/attachments/${attachment.id}/file`);

    const file = await agent.get(attachment.href).expect(200);
    expect(Buffer.compare(file.body, png)).toBe(0);
    expect(readFileSync(join(dataDir, attachment.stored_path))).toEqual(png);
  });

  it("suggests local paths from the task workspace without recursing", async () => {
    const workdir = makeTempDir("worklab-suggest-workdir-");
    const dataDir = makeTempDir("worklab-suggest-data-");
    mkdirSync(join(workdir, "src", "deep"), { recursive: true });
    writeFileSync(join(workdir, "src", "app.js"), "app");
    writeFileSync(join(workdir, "src", ".secret"), "hidden");
    writeFileSync(join(workdir, "src", "deep", "nested.js"), "nested");
    const { agent } = makeTestServer({
      dataDir,
      config: { dataDir, repoRoot: workdir, workspace: workdir },
    });
    const task = await agent.post("/api/tasks").send({ title: "Suggest paths" }).expect(201);

    const res = await agent
      .get(`/api/files/suggest?task_id=${task.body.task.id}&prefix=src/a&limit=10`)
      .expect(200);

    expect(res.body.results).toContainEqual(expect.objectContaining({
      kind: "file",
      name: "app.js",
      path: "src/app.js",
    }));
    expect(res.body.results.map((item) => item.path)).not.toContain("src/deep/nested.js");
    expect(res.body.results.map((item) => item.path)).not.toContain("src/.secret");

    const hidden = await agent
      .get(`/api/files/suggest?task_id=${task.body.task.id}&prefix=src/.&limit=10`)
      .expect(200);
    expect(hidden.body.results.map((item) => item.path)).toContain("src/.secret");
  });

  it("suggests local paths from an explicit project workdir", async () => {
    const workdir = makeTempDir("worklab-suggest-project-workdir-");
    const dataDir = makeTempDir("worklab-suggest-project-data-");
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "project.js"), "project");
    const { agent } = makeTestServer({
      dataDir,
      config: { dataDir, repoRoot: dataDir, workspace: dataDir },
    });
    const project = await agent.post("/api/projects").send({
      name: "Suggestion Project",
      workdir,
    }).expect(201);

    const res = await agent
      .get(`/api/files/suggest?project_id=${project.body.project.slug}&prefix=src/pro&limit=10`)
      .expect(200);

    expect(res.body.base_workdir).toBe(workdir);
    expect(res.body.results).toContainEqual(expect.objectContaining({
      kind: "file",
      name: "project.js",
      path: "src/project.js",
      absolute_path: join(workdir, "src", "project.js"),
    }));
  });

  describe("/api/files/read", () => {
    it("returns file contents when the path resolves inside the task workdir", async () => {
      const workdir = makeTempDir("worklab-read-workdir-");
      const dataDir = makeTempDir("worklab-read-data-");
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "app.js"), "console.log('hi');\n");
      const { agent } = makeTestServer({
        dataDir,
        config: { dataDir, repoRoot: workdir, workspace: workdir },
      });
      const task = await agent.post("/api/tasks").send({ title: "Read file" }).expect(201);

      const res = await agent
        .get(`/api/files/read?task_id=${task.body.task.id}&path=${encodeURIComponent("src/app.js")}`)
        .expect(200);

      expect(res.body).toMatchObject({
        encoding: "utf8",
        truncated: false,
        content: "console.log('hi');\n",
        abs_path: realpathSync(join(workdir, "src", "app.js")),
      });
    });

    it("rejects paths outside the workdir", async () => {
      const workdir = makeTempDir("worklab-read-outside-workdir-");
      const dataDir = makeTempDir("worklab-read-outside-data-");
      const outside = makeTempDir("worklab-read-outside-target-");
      writeFileSync(join(outside, "secret.txt"), "nope");
      const { agent } = makeTestServer({
        dataDir,
        config: { dataDir, repoRoot: workdir, workspace: workdir },
      });
      const task = await agent.post("/api/tasks").send({ title: "Outside" }).expect(201);

      const res = await agent
        .get(`/api/files/read?task_id=${task.body.task.id}&path=${encodeURIComponent(join(outside, "secret.txt"))}`)
        .expect(403);

      expect(res.body.error?.code).toBe("outside_workdir");
    });

    it("allows child filenames whose first segment starts with dots", async () => {
      const workdir = makeTempDir("worklab-read-dotfile-workdir-");
      const dataDir = makeTempDir("worklab-read-dotfile-data-");
      writeFileSync(join(workdir, "..env"), "still inside\n");
      const { agent } = makeTestServer({
        dataDir,
        config: { dataDir, repoRoot: workdir, workspace: workdir },
      });
      const task = await agent.post("/api/tasks").send({ title: "Dot child" }).expect(201);

      const res = await agent
        .get(`/api/files/read?task_id=${task.body.task.id}&path=${encodeURIComponent("..env")}`)
        .expect(200);

      expect(res.body.content).toBe("still inside\n");
      expect(res.body.abs_path).toBe(realpathSync(join(workdir, "..env")));
    });

    it("returns 403 when a file cannot be read", async () => {
      if (process.platform === "win32" || process.getuid?.() === 0) return;

      const workdir = makeTempDir("worklab-read-forbidden-workdir-");
      const dataDir = makeTempDir("worklab-read-forbidden-data-");
      const unreadable = join(workdir, "secret.txt");
      writeFileSync(unreadable, "nope");
      chmodSync(unreadable, 0o000);
      const { agent } = makeTestServer({
        dataDir,
        config: { dataDir, repoRoot: workdir, workspace: workdir },
      });
      const task = await agent.post("/api/tasks").send({ title: "Forbidden" }).expect(201);

      try {
        const res = await agent
          .get(`/api/files/read?task_id=${task.body.task.id}&path=secret.txt`)
          .expect(403);

        expect(res.body.error).toMatchObject({
          code: "forbidden",
          message: "file is not readable",
        });
      } finally {
        chmodSync(unreadable, 0o600);
      }
    });

    it("flags binary files instead of returning their content", async () => {
      const workdir = makeTempDir("worklab-read-binary-workdir-");
      const dataDir = makeTempDir("worklab-read-binary-data-");
      const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
      writeFileSync(join(workdir, "blob.bin"), binary);
      const { agent } = makeTestServer({
        dataDir,
        config: { dataDir, repoRoot: workdir, workspace: workdir },
      });
      const task = await agent.post("/api/tasks").send({ title: "Binary" }).expect(201);

      const res = await agent
        .get(`/api/files/read?task_id=${task.body.task.id}&path=blob.bin`)
        .expect(200);

      expect(res.body.encoding).toBe("binary");
      expect(res.body.content).toBe("");
    });

    it("returns 404 for missing files", async () => {
      const workdir = makeTempDir("worklab-read-missing-workdir-");
      const dataDir = makeTempDir("worklab-read-missing-data-");
      const { agent } = makeTestServer({
        dataDir,
        config: { dataDir, repoRoot: workdir, workspace: workdir },
      });
      const task = await agent.post("/api/tasks").send({ title: "Missing" }).expect(201);

      const res = await agent
        .get(`/api/files/read?task_id=${task.body.task.id}&path=does-not-exist.txt`)
        .expect(404);

      expect(res.body.error?.code).toBe("not_found");
    });
  });
});
