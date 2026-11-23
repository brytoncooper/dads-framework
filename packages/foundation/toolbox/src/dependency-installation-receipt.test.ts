/** Proves an installation is only claimed when node_modules exists and the receipt still matches the manifest and lockfile. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dependenciesAreInstalled, recordDadsDependencyInstallation } from "./dependency-installation-receipt.js";

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectRoot of temporaryProjects.splice(0)) rmSync(projectRoot, { recursive: true, force: true });
});

describe("dependency installation receipt", () => {
  it("reports nothing installed while node_modules is absent", () => {
    const projectRoot = createProject();
    recordDadsDependencyInstallation(projectRoot);

    expect(dependenciesAreInstalled(projectRoot)).toBe(false);
  });

  it("reports nothing installed when no receipt was ever recorded", () => {
    const projectRoot = createProject();
    mkdirSync(join(projectRoot, "node_modules"));

    expect(dependenciesAreInstalled(projectRoot)).toBe(false);
  });

  it("reports the recorded installation while the manifest is unchanged", () => {
    const projectRoot = createProject();
    mkdirSync(join(projectRoot, "node_modules"));
    recordDadsDependencyInstallation(projectRoot);

    expect(dependenciesAreInstalled(projectRoot)).toBe(true);
    expect(readFileSync(join(projectRoot, ".dads/dependency-installation.sha256"), "utf8")).toMatch(/^[a-f0-9]{64}\n$/);
  });

  it("stops reporting an installation once the manifest changes", () => {
    const projectRoot = createProject();
    mkdirSync(join(projectRoot, "node_modules"));
    recordDadsDependencyInstallation(projectRoot);
    writeFileSync(
      join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "api", dependencies: { pg: "^8.13.0" } })}\n`,
    );

    expect(dependenciesAreInstalled(projectRoot)).toBe(false);

    recordDadsDependencyInstallation(projectRoot);
    expect(dependenciesAreInstalled(projectRoot)).toBe(true);
  });

  it("requires a matching npm lockfile", () => {
    const projectRoot = createProject();
    const lockPath = join(projectRoot, "package-lock.json");
    mkdirSync(join(projectRoot, "node_modules"));
    recordDadsDependencyInstallation(projectRoot);

    writeFileSync(lockPath, '{"name":"another-app","lockfileVersion":3}\n');
    expect(dependenciesAreInstalled(projectRoot)).toBe(false);

    rmSync(lockPath);
    expect(dependenciesAreInstalled(projectRoot)).toBe(false);
  });
});

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "dads-install-receipt-"));
  temporaryProjects.push(projectRoot);
  writeFileSync(join(projectRoot, "package.json"), `${JSON.stringify({ name: "api", dependencies: {} })}\n`);
  writeFileSync(join(projectRoot, "package-lock.json"), '{"name":"api","lockfileVersion":3}\n');
  return projectRoot;
}
