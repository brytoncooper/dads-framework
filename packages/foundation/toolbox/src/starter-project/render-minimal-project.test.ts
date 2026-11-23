/** Proves the minimal template preserves full framework shape with zero example domains. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { generateProjectArtifact } from "../cli-generator-commands.js";
import { checkDomainBoundaries } from "../domain-boundaries/check-domain-boundaries.js";
import { parseDadsProject } from "../project-orientation.js";
import { parseGeneratorArguments } from "../resource-generators/generator-arguments.js";
import { renderMinimalProjectFiles } from "./render-minimal-project.js";
import { renderStarterProjectFiles, type StarterProjectFile } from "./render-starter-project.js";

const workspace = fileURLToPath(new URL("../../../../../", import.meta.url));
const nodeModules = join(workspace, "node_modules");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("renderMinimalProjectFiles", () => {
  it("emits the full framework skeleton and strips all example and demo files", () => {
    const files = renderMinimalProjectFiles({ projectName: "lean-app" });
    const paths = files.map((file) => file.path);

    for (const required of [
      ".agents/skills/add-domain/SKILL.md",
      "AGENTS.md",
      "CLAUDE.md",
      "DEPLOY.md",
      "README.md",
      "apps/customer/app.ts",
      "apps/staff/app.ts",
      "apps/web/account-form.tsx",
      "apps/web/main.tsx",
      "apps/web/workbench.tsx",
      "apps/web/workspace-controls.tsx",
      "assembly/compose.yml",
      "assembly/migrations.ts",
      "assembly/services.ts",
      "assembly/start-app.ts",
      "ci/verify.sh",
      "dads.project.json",
      "domains/tenants/index.ts",
      "libraries/app-runtime/index.ts",
      "migrations/20261120080000_starter.migration.ts",
      "migrations/20261120080100_email_delivery.migration.ts",
      "package.json",
      "scripts/verify.mjs",
      "tests/starter.integration.test.ts",
      "tsconfig.json",
      "vite.config.ts",
    ]) {
      expect(paths).toContain(required);
    }

    expect(paths.filter((path) => path.startsWith("domains/notes/"))).toEqual([]);
    expect(paths.filter((path) => path.startsWith("domains/support/"))).toEqual([]);
    expect(paths.filter((path) => path.startsWith("examples/"))).toEqual([]);
    expect(paths).not.toContain("examples.html");
    expect(paths).not.toContain("apps/web/notes.tsx");
    expect(paths).not.toContain("apps/web/note-forms.tsx");
    expect(paths).not.toContain("apps/web/note-list.tsx");
    expect(paths).not.toContain("apps/web/permissions-dashboard.tsx");
    expect(paths).not.toContain("apps/web/enterprise-sign-in-form.tsx");
    expect(paths).not.toContain("apps/web/enterprise-sign-in-client.ts");
    expect(paths).not.toContain("migrations/20261120080200_enable_notes_exports.migration.ts");
    expect(paths).not.toContain("migrations/20261120080300_enterprise_identity.migration.ts");
    expect(paths).not.toContain("migrations/20261120080400_staff_impersonation.migration.ts");
  });

  it("keeps clean manifests, generator markers, and zero dangling example imports", () => {
    const files = renderMinimalProjectFiles({ projectName: "lean-app" });
    const byPath = new Map(files.map((file) => [file.path, file.content]));

    const projectJson = byPath.get("dads.project.json") ?? "";
    const parsedProject = parseDadsProject(JSON.parse(projectJson));
    const packageRoots = parsedProject.packages.map((pkg) => pkg.root);
    expect(packageRoots).toContain("apps");
    expect(packageRoots).toContain("assembly");
    expect(packageRoots).toContain("domains/tenants");
    expect(packageRoots).toContain("libraries/app-runtime");
    expect(packageRoots).toContain("migrations");
    expect(packageRoots).not.toContain("domains/notes");
    expect(packageRoots).not.toContain("domains/support");
    expect(packageRoots).not.toContain("libraries/sign-in-options");

    for (const entrypoint of ["apps/customer/app.ts", "apps/staff/app.ts"]) {
      const source = byPath.get(entrypoint) ?? "";
      expect(source).toContain("// dad:add imports");
      expect(source).toContain("// dad:add domains");
      expect(source).not.toContain("domains/notes");
      expect(source).not.toContain("domains/support");
    }

    const migrations = byPath.get("assembly/migrations.ts") ?? "";
    expect(migrations).toContain("// dad:add imports");
    expect(migrations).toContain("// dad:add migrations");

    const workbench = byPath.get("apps/web/workbench.tsx") ?? "";
    expect(workbench).not.toContain("./notes.js");
    expect(workbench).not.toContain("./permissions-dashboard.js");

    const webMain = byPath.get("apps/web/main.tsx") ?? "";
    expect(webMain).not.toContain("examples.html");

    const manifest = byPath.get("package.json") ?? "";
    expect(manifest).toContain('"name": "lean-app"');
    expect(manifest).not.toContain("examples:setup");
  });

  it("keeps --template example identical to the default starter", () => {
    const defaultFiles = renderStarterProjectFiles({
      projectName: "sample-app",
    });
    const exampleFiles = renderStarterProjectFiles({
      projectName: "sample-app",
      template: "example",
    });
    expect(exampleFiles).toEqual(defaultFiles);
    expect(exampleFiles.map((file) => file.path)).toContain("domains/notes/server/routes.ts");
  });

  it("rejects invalid project names", () => {
    expect(() => renderMinimalProjectFiles({ projectName: "Invalid Name" })).toThrow(
      /Dads project names must use lowercase/,
    );
  });

  it(
    "typechecks, passes domain boundaries, and accepts dad add resource products --api customer",
    { timeout: 120_000 },
    () => {
      const scratch = temporaryDirectory();
      writeProject(
        scratch,
        renderStarterProjectFiles({
          projectName: "minimal-conformance",
          template: "minimal",
        }),
      );

      expect(checkDomainBoundaries(scratch)).toEqual({
        ok: true,
        violations: [],
      });
      runTool(scratch, "typescript/bin/tsc", ["-p", "tsconfig.json", "--noEmit"]);

      const generated = generateProjectArtifact(
        scratch,
        parseGeneratorArguments(["resource", "products", "--api", "customer"]),
      );
      expect(generated.files.length).toBeGreaterThan(0);
      expect(readFileSync(join(scratch, "apps/customer/app.ts"), "utf8")).toContain("productsPlugin");
      expect(readFileSync(join(scratch, "assembly/migrations.ts"), "utf8")).toContain("products");

      expect(checkDomainBoundaries(scratch)).toEqual({
        ok: true,
        violations: [],
      });
      runTool(scratch, "typescript/bin/tsc", ["-p", "tsconfig.json", "--noEmit"]);
      const testOutput = runTool(scratch, "vitest/vitest.mjs", [
        "run",
        "--reporter=verbose",
        "domains/products",
        "tests/session-subjects.test.ts",
        "tests/local-stack.test.mjs",
      ]);
      expect(testOutput).toContain("products-resource.test.ts");
      expect(testOutput).toContain("session-subjects.test.ts");
      expect(testOutput).toContain("local-stack.test.mjs");
    },
  );
});

function writeProject(scratch: string, files: readonly StarterProjectFile[]): void {
  for (const file of files) {
    const target = join(scratch, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  symlinkSync(nodeModules, join(scratch, "node_modules"), "junction");
}

function runTool(scratch: string, executable: string, args: readonly string[]): string {
  return execFileSync(process.execPath, [join(nodeModules, executable), ...args], {
    cwd: scratch,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-minimal-starter-"));
  temporaryDirectories.push(directory);
  return directory;
}
