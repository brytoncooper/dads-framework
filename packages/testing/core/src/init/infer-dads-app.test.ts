import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkTestingManifest } from "./check-testing-manifest.js";
import { detectWorkspace } from "./detect-workspace.js";
import { inferDadsAppManifest } from "./infer-dads-app.js";
import { initTestingManifest } from "./init-testing-manifest.js";
import { readWorkspacePackages } from "./package-inventory.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "..");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Dads application manifest inference", () => {
  it("infers per-domain projects and Vitest file narrowing from dads.project.json", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "@example/notes-app",
        scripts: { test: "vitest run", typecheck: "tsc -p tsconfig.json --noEmit" },
      }),
      "vite.config.ts": "export default {};\n",
      "dads.project.json": JSON.stringify({
        schemaVersion: 1,
        packages: [
          { name: "domains-notes", root: "domains/notes", kind: "core" },
          { name: "libraries-runtime", root: "libraries/runtime", kind: "core" },
          { name: "migrations", root: "migrations", kind: "binding" },
          { name: "assembly", root: "assembly", kind: "binding" },
        ],
      }),
      "domains/notes/note-rules.ts": "export const normalize = (value: string): string => value.trim();\n",
      "domains/notes/note-rules.test.ts": "export {};\n",
      "libraries/runtime/clock.ts": "export const now = (): number => 0;\n",
      "migrations/001.sql": "CREATE TABLE notes (id text);\n",
      "assembly/main.ts": "export {};\n",
      "tests/smoke.test.ts": "export {};\n",
      "tests/notes.integration.test.ts": "export {};\n",
    });

    const result = await initTestingManifest({
      workspaceRoot,
      environment: {},
      resolveNativeBinary: () => undefined,
    });

    expect(checkTestingManifest(result.manifest)).toEqual([]);
    expect(result.manifest.projects.map((project) => project.id)).toEqual([
      "assembly",
      "domains-notes",
      "example-notes-app",
      "libraries-runtime",
      "migrations",
    ]);
    expect(result.manifest.projects.find((project) => project.id === "domains-notes")?.fallbackDependencies).toEqual([
      "libraries-runtime",
    ]);
    expect(
      result.manifest.projects.find((project) => project.id === "example-notes-app")?.fallbackDependencies,
    ).toEqual(["assembly", "domains-notes", "libraries-runtime", "migrations"]);

    const notesUnit = result.manifest.tasks.find((task) => task.id === "domains-notes:unit");
    expect(notesUnit?.execution.args).toEqual([
      "vitest",
      "run",
      "--dir",
      "domains/notes",
      "--exclude",
      "**/*.integration.test.*",
      "--exclude",
      "**/*.integration.spec.*",
    ]);
    expect(notesUnit?.execution.fileNarrowing?.setupFiles).toEqual(["vite.config.ts"]);
    expect(notesUnit?.dependsOn).toEqual(["example-notes-app:typecheck"]);

    const rootIntegration = result.manifest.tasks.find((task) => task.id === "example-notes-app:integration");
    expect(rootIntegration?.execution.fileNarrowing?.suffixes).toContain(".integration.test.ts");
    expect(result.manifest.tasks.find((task) => task.id === "libraries-runtime:unit")).toBeUndefined();
  });

  it("produces a structurally valid manifest for apps/kit-workbench", () => {
    const workbenchRoot = join(repositoryRoot, "apps", "kit-workbench");
    if (!existsSync(join(workbenchRoot, "dads.project.json"))) return;

    const workspace = detectWorkspace(workbenchRoot);
    const packages = readWorkspacePackages(workbenchRoot, workspace.packageDirectories);
    const inferred = inferDadsAppManifest(workbenchRoot, workspace, packages);

    expect(inferred?.manifest).toBeDefined();
    if (inferred?.manifest === undefined) return;
    expect(checkTestingManifest(inferred.manifest)).toEqual([]);
    expect(inferred.manifest.tasks.map((task) => task.id)).toContain("domains-notes:unit");
    expect(inferred.manifest.tasks.map((task) => task.id)).toContain("assembly:unit");
    expect(inferred.manifest.tasks.map((task) => task.id)).toContain("dads-fixture-kit-workbench:integration");
    expect(inferred.manifest.tasks.map((task) => task.id)).toContain("dads-fixture-kit-workbench:unit");
    expect(inferred.manifest.tasks.map((task) => task.id)).toContain("dads-fixture-kit-workbench:typecheck");
  });
});

function makeWorkspace(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-app-init-"));
  temporaryDirectories.push(directory);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(directory, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return directory;
}
