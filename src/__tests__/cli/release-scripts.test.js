import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPackages, publishablePackages, sortForPublish } from "../../../scripts/release/package-graph.mjs";
import { releaseVersionFromTag, validateRelease } from "../../../scripts/release/validate-release.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readRootPackage() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

describe("release automation scripts", () => {
  it("derives the release version from a repo tag", () => {
    expect(releaseVersionFromTag("v1.2.3")).toBe("1.2.3");
    expect(releaseVersionFromTag("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(() => releaseVersionFromTag("agent-runtime-v1.2.3")).toThrow(/release tag must look like/);
  });

  it("publishes workspace packages before the root package", () => {
    const packages = publishablePackages(discoverPackages());
    const order = sortForPublish(packages).map((pkg) => pkg.name);

    expect(order).toContain("@worklab-ai/agent-runtime");
    expect(order).toContain("@worklab-ai/worklab");
    expect(order).not.toContain("echo-agent");
    expect(order.indexOf("@worklab-ai/agent-runtime")).toBeLessThan(order.indexOf("@worklab-ai/worklab"));
    expect(order.at(-1)).toBe("@worklab-ai/worklab");
  });

  it("validates the current repo-wide release version", () => {
    const root = readRootPackage();
    const release = validateRelease({ tag: `v${root.version}`, silent: true });

    expect(release.version).toBe(root.version);
    expect(release.publishablePackages.map((pkg) => `${pkg.name}@${pkg.version}`)).toContain(
      `@worklab-ai/agent-runtime@${root.version}`,
    );
    expect(release.publishablePackages.map((pkg) => `${pkg.name}@${pkg.version}`)).toContain(
      `@worklab-ai/worklab@${root.version}`,
    );
  });

  it("rejects tag and package version drift", () => {
    expect(() => validateRelease({ tag: "v0.0.0", silent: true }))
      .toThrow(/version must be 0\.0\.0/);
  });
});
