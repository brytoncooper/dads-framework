/** Proves initialization is safe, repeatable, and isolated in existing apps. */

import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDadsProject } from "./initialize-dads-project.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("initialize Dads project", () => {
  it("creates the kit project and treats an identical rerun as unchanged", () => {
    const targetDirectory = temporaryDirectory();
    const first = initializeDadsProject({
      targetDirectory,
      mode: "new",
      projectName: "clear-api",
    });
    const second = initializeDadsProject({
      targetDirectory,
      mode: "new",
      projectName: "clear-api",
    });

    expect(first.created).toContain("domains/notes/server/routes.ts");
    expect(first.created).toContain("apps/staff/app.ts");
    expect(first.created).toContain(".codex/skills");
    expect(
      lstatSync(join(targetDirectory, ".codex/skills")).isSymbolicLink(),
    ).toBe(true);
    expect(readlinkSync(join(targetDirectory, ".codex/skills"))).toBe(
      "../.agents/skills",
    );
    expect(readFileSync(join(targetDirectory, "AGENTS.md"), "utf8")).toContain(
      "# Dads app",
    );
    expect(second.created).toEqual([]);
    expect(second.unchanged).toEqual(first.created);
  });

  it("refuses to overwrite an owned file with different content", () => {
    const targetDirectory = temporaryDirectory();
    initializeDadsProject({
      targetDirectory,
      mode: "new",
      projectName: "clear-api",
    });
    writeFileSync(
      join(targetDirectory, "domains/notes/server/routes.ts"),
      "user-owned change\n",
    );

    expect(() =>
      initializeDadsProject({
        targetDirectory,
        mode: "new",
        projectName: "clear-api",
      }),
    ).toThrow(/Refusing to overwrite.*domains\/notes\/server\/routes\.ts/);
  });

  it("adds an isolated Dads project without changing the existing app", () => {
    const targetDirectory = temporaryDirectory();
    const existingPackage = '{"name":"existing-app","private":true}\n';
    writeFileSync(join(targetDirectory, "package.json"), existingPackage);

    const result = initializeDadsProject({
      targetDirectory,
      mode: "existing",
      projectName: "existing-app-dads",
    });

    expect(result.projectRoot).toBe(join(targetDirectory, "dads"));
    expect(readFileSync(join(targetDirectory, "package.json"), "utf8")).toBe(
      existingPackage,
    );
    expect(result.created).toContain("assembly/services.ts");
    expect(result.created).toContain("tests/starter.integration.test.ts");
    expect(result.created).toContain("apps/customer/app.ts");
    expect(
      readFileSync(join(targetDirectory, "dads", "package.json"), "utf8"),
    ).toContain("@dads-framework/postgres-access");
  });

  it("emits the kit dependencies and provider-neutral CI", () => {
    const targetDirectory = temporaryDirectory();
    initializeDadsProject({
      targetDirectory,
      mode: "new",
      projectName: "kit-api",
    });
    const manifest = readFileSync(
      join(targetDirectory, "package.json"),
      "utf8",
    );
    expect(manifest).toContain("@dads-framework/http");
    expect(manifest).toContain("@dads-framework/identity-better-auth");
    expect(manifest).toContain("@dads-framework/tenants");
    expect(manifest).toContain("@dads-framework/postgres-access");
    expect(manifest).not.toMatch(/legacy-(?:http|authorization)/);
    expect(
      readFileSync(join(targetDirectory, "ci/verify.sh"), "utf8"),
    ).toContain("npm run verify");
  });

  it("refuses to initialize a non-empty directory it does not recognize", () => {
    const targetDirectory = temporaryDirectory();
    writeFileSync(join(targetDirectory, "package.json"), '{"name":"host"}\n');

    expect(() =>
      initializeDadsProject({
        targetDirectory,
        mode: "new",
        projectName: "host-api",
      }),
    ).toThrow(
      `Refusing to initialize non-empty directory ${targetDirectory}. Use existing-project mode to add an isolated Dads project.`,
    );
    expect(readFileSync(join(targetDirectory, "package.json"), "utf8")).toBe(
      '{"name":"host"}\n',
    );
  });

  it("previews every change without writing a file", () => {
    const targetDirectory = temporaryDirectory();
    const result = initializeDadsProject({
      targetDirectory,
      mode: "new",
      projectName: "preview-api",
      dryRun: true,
    });

    expect(result.created).toContain("dads.project.json");
    expect(() =>
      readFileSync(join(targetDirectory, "dads.project.json"), "utf8"),
    ).toThrow();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-initialize-"));
  temporaryDirectories.push(directory);
  return directory;
}
