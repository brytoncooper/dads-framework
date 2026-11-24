import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEnforceModuleBoundariesRule,
  loadWorkspaceBoundaryIndex,
  type EslintReportDescriptor,
  type ModuleBoundariesOptions,
} from "./index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createBoundaryWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dads-eslint-boundaries-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "libs/ui/src"), { recursive: true });
  mkdirSync(join(dir, "libs/server/src"), { recursive: true });
  mkdirSync(join(dir, "libs/buildable/src"), { recursive: true });
  mkdirSync(join(dir, "libs/non-buildable/src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { zod: "^4.0.0" } }));
  writeFileSync(
    join(dir, "tsconfig.base.json"),
    JSON.stringify({
      compilerOptions: {
        paths: {
          "@ws/ui": ["libs/ui/src/index.ts"],
          "@ws/server": ["libs/server/src/index.ts"],
          "@ws/buildable": ["libs/buildable/src/index.ts"],
          "@ws/non-buildable": ["libs/non-buildable/src/index.ts"],
        },
      },
    }),
  );
  writeFileSync(join(dir, "libs/ui/project.json"), JSON.stringify({ name: "ui", tags: ["env:browser"] }));
  writeFileSync(join(dir, "libs/server/project.json"), JSON.stringify({ name: "server", tags: ["env:server"] }));
  writeFileSync(
    join(dir, "libs/buildable/project.json"),
    JSON.stringify({ name: "buildable", projectType: "library", tags: ["shared"], targets: { build: {} } }),
  );
  writeFileSync(
    join(dir, "libs/non-buildable/project.json"),
    JSON.stringify({ name: "non-buildable", projectType: "library", tags: ["shared"] }),
  );
  // Seed reverse edge server -> ui so ui -> server triggers circularDependency!
  writeFileSync(join(dir, "libs/server/src/index.ts"), 'import { x } from "@ws/ui";\nexport const s = x;\n');
  writeFileSync(join(dir, "libs/ui/src/index.ts"), "export const x = 1;\n");
  return dir;
}

function runImports(
  workspaceRoot: string,
  relFile: string,
  specifiers: readonly string[],
  options: ModuleBoundariesOptions,
): readonly EslintReportDescriptor[] {
  const index = loadWorkspaceBoundaryIndex(workspaceRoot);
  const rule = createEnforceModuleBoundariesRule(index);
  const reports: EslintReportDescriptor[] = [];
  const visitors = rule.create({
    options: [options],
    filename: join(workspaceRoot, relFile),
    report: (descriptor) => reports.push(descriptor),
  });
  const visitImport = visitors["ImportDeclaration"];
  expect(visitImport).toBeDefined();
  for (const spec of specifiers) {
    visitImport?.({ source: { type: "Literal", value: spec } });
  }
  return reports;
}

describe("@dads-framework/testing/eslint enforce-module-boundaries", () => {
  it("reports cross-project relative imports, tag constraints, cycles, banned externals, transitive deps, and buildable lib violations", () => {
    const dir = createBoundaryWorkspace();
    const options: ModuleBoundariesOptions = {
      enforceBuildableLibDependency: true,
      banTransitiveDependencies: true,
      allow: ["@ws/allowed-special"],
      depConstraints: [
        {
          sourceTag: "env:browser",
          onlyDependOnLibsWithTags: ["env:browser", "shared"],
          notDependOnLibsWithTags: ["env:server"],
          bannedExternalImports: ["pg", "node-pg-*"],
        },
      ],
    };

    const uiReports = runImports(
      dir,
      "libs/ui/src/page.ts",
      ["../../server/src/index.js", "@ws/server", "pg", "node-pg-migrate", "undeclared-pkg", "zod", "node:fs"],
      options,
    );
    const ids = uiReports.map((r) => r.messageId);
    expect(ids).toContain("noRelativeCrossProject");
    expect(ids).toContain("tagConstraint");
    expect(ids).toContain("notTagConstraint");
    expect(ids).toContain("circularDependency");
    expect(ids).toContain("bannedExternal");
    expect(ids).toContain("transitiveDependency");
    // Declared root dependency (`zod`) and Node builtin (`node:fs`) must pass cleanly.
    expect(uiReports.some((r) => r.data?.["pkg"] === "zod")).toBe(false);

    const buildableReports = runImports(dir, "libs/buildable/src/index.ts", ["@ws/non-buildable"], options);
    expect(buildableReports.map((r) => r.messageId)).toEqual(["buildableLibDependency"]);
  });
});
