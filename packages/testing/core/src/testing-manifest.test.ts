import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseTestingManifest, readTestingManifest, serializeTestingManifest } from "./testing-manifest.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const workspaceRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

const minimalManifest = JSON.stringify({
  schemaVersion: 1,
  workspace: { fullFallback: { taskIds: ["api:test"] } },
  projects: [{ id: "api", root: "apps/api" }],
  tasks: [
    {
      id: "api:test",
      project: "api",
      kind: "test",
      execution: { executable: "npm" },
      impact: { mode: "reachability" },
    },
  ],
});

describe("testing manifest", () => {
  for (const fixture of ["testing", "testing-soundness"]) {
    it(`round-trips the ${fixture} fixture manifest`, () => {
      const path = join(workspaceRoot, "fixtures", fixture, "dads.testing.json");
      const manifest = parseTestingManifest(readFileSync(path, "utf8"), "dads.testing.json");

      const serialized = serializeTestingManifest(manifest);

      expect(serialized.endsWith("}\n")).toBe(true);
      expect(serialized).toContain('\n  "schemaVersion": 1,');
      expect(parseTestingManifest(serialized, "round-trip")).toEqual(manifest);
    });
  }

  it("applies every declared default", () => {
    const manifest = parseTestingManifest(minimalManifest, "dads.testing.json");

    expect(manifest.workspace.root).toBeUndefined();
    expect(manifest.projects[0]?.fallbackDependencies).toEqual([]);
    expect(manifest.tasks[0]?.execution.args).toEqual([]);
    expect(manifest.tasks[0]?.execution.shell).toBe(false);
    expect(manifest.tasks[0]?.execution.cwd).toBeUndefined();
    expect(manifest.tasks[0]?.dependsOn).toEqual([]);
    expect(manifest.tasks[0]?.impact.paths).toEqual([]);
  });

  it("omits defaulted keys when serializing", () => {
    const manifest = parseTestingManifest(minimalManifest, "dads.testing.json");

    const serialized = serializeTestingManifest(manifest);

    expect(serialized).not.toContain('"shell"');
    expect(serialized).not.toContain('"cwd"');
    expect(serialized).toContain('"workspace": {\n    "fullFallback": {');
    expect(serialized).toContain('"args": []');
  });

  it("rejects an unknown key rather than ignoring it", () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      workspace: { fullFallback: { taskIds: [] } },
      projects: [],
      tasks: [
        {
          id: "api:test",
          project: "api",
          kind: "test",
          execution: { executable: "npm", shel: true },
          impact: { mode: "always" },
        },
      ],
    });

    expect(() => parseTestingManifest(text, "dads.testing.json")).toThrow(
      'dads.testing.json: unknown key "shel" in tasks[0].execution',
    );
  });

  it("rejects an unsupported schema version and a wrong type", () => {
    expect(() => parseTestingManifest(JSON.stringify({ schemaVersion: 2 }), "manifest")).toThrow(
      "manifest: schemaVersion must be 1",
    );
    expect(() =>
      parseTestingManifest(
        JSON.stringify({
          schemaVersion: 1,
          workspace: { fullFallback: { taskIds: [] } },
          projects: [{ id: "api", root: 7 }],
          tasks: [],
        }),
        "manifest",
      ),
    ).toThrow("manifest: projects[0].root must be a string");
  });

  it("reads the default manifest from the workspace root", () => {
    const directory = makeTemporaryDirectory();
    writeFileSync(join(directory, "dads.testing.json"), minimalManifest, "utf8");

    const manifest = readTestingManifest(directory);

    expect(manifest.tasks[0]?.id).toBe("api:test");
  });

  it("refuses a manifest path outside the workspace", () => {
    const directory = makeTemporaryDirectory();

    expect(() => readTestingManifest(directory, "../escaped.json")).toThrow(
      "The manifest path must stay inside the workspace: ../escaped.json",
    );
  });

  it("round-trips execution.fileNarrowing cleanly", () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      workspace: { fullFallback: { taskIds: ["api:unit"] } },
      projects: [{ id: "api", root: "apps/api" }],
      tasks: [
        {
          id: "api:unit",
          project: "api",
          kind: "test",
          execution: {
            executable: "npx",
            args: ["vitest", "run"],
            fileNarrowing: {
              suffixes: [".test.ts"],
              excludeSuffixes: [".integration.test.ts"],
              setupFiles: ["vitest.config.ts"],
            },
          },
          impact: { mode: "reachability" },
        },
      ],
    });
    const manifest = parseTestingManifest(text, "dads.testing.json");

    expect(manifest.tasks[0]?.execution.fileNarrowing).toEqual({
      suffixes: [".test.ts"],
      excludeSuffixes: [".integration.test.ts"],
      setupFiles: ["vitest.config.ts"],
    });
    expect(parseTestingManifest(serializeTestingManifest(manifest), "round-trip")).toEqual(manifest);
  });

  it("parses, validates, and deterministically serializes execution.env", () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      workspace: { fullFallback: { taskIds: ["api:test"] } },
      projects: [{ id: "api", root: "apps/api" }],
      tasks: [
        {
          id: "api:test",
          project: "api",
          kind: "test",
          execution: {
            executable: "npx",
            args: ["vitest", "run"],
            env: { Z_VAR: "2", VITEST_TIER: "unit" },
          },
          impact: { mode: "reachability" },
        },
      ],
    });
    const manifest = parseTestingManifest(text, "dads.testing.json");

    expect(manifest.tasks[0]?.execution.env).toEqual({ VITEST_TIER: "unit", Z_VAR: "2" });
    expect(Object.keys(manifest.tasks[0]?.execution.env ?? {})).toEqual(["VITEST_TIER", "Z_VAR"]);
    expect(parseTestingManifest(serializeTestingManifest(manifest), "round-trip")).toEqual(manifest);

    expect(() => parseTestingManifest(text.replace('"Z_VAR":"2"', '"BAD=KEY":"1"'), "dads.testing.json")).toThrow(
      /invalid key/,
    );
  });

  it("round-trips workspace.sql and task.sqlImpact cleanly", () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      workspace: {
        fullFallback: { taskIds: ["db:migrate", "maint:integration"] },
        sql: {
          migrationRoots: ["migrations/sql"],
          objects: ["public.maintenance_records", "public.users"],
          edges: [{ from: "public.maintenance_records", to: "public.users" }],
          snapshotPatterns: [{ prefix: "migrations/grants/", suffix: ".txt" }],
        },
      },
      projects: [
        { id: "db", root: "migrations" },
        { id: "maint", root: "domains/maint", fallbackDependencies: ["db"] },
      ],
      tasks: [
        {
          id: "db:migrate",
          project: "db",
          kind: "test",
          execution: { executable: "true" },
          impact: { mode: "reachability" },
          sqlImpact: { isMigrationRunner: true },
        },
        {
          id: "maint:integration",
          project: "maint",
          kind: "test",
          execution: { executable: "true" },
          impact: { mode: "reachability" },
          sqlImpact: { tables: ["public.maintenance_records"] },
        },
      ],
    });
    const manifest = parseTestingManifest(text, "dads.testing.json");
    expect(manifest.workspace.sql?.migrationRoots).toEqual(["migrations/sql"]);
    expect(manifest.tasks[0]?.sqlImpact).toEqual({ isMigrationRunner: true });
    expect(manifest.tasks[1]?.sqlImpact).toEqual({ tables: ["public.maintenance_records"] });
    expect(parseTestingManifest(serializeTestingManifest(manifest), "round-trip")).toEqual(manifest);
  });

  it("round-trips workspace.boundaries and project.tags cleanly and rejects unknown keys", () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      workspace: {
        fullFallback: { taskIds: ["ui:test"] },
        boundaries: {
          depConstraints: [
            {
              sourceTag: "env:browser",
              onlyDependOnLibsWithTags: ["env:browser", "shared"],
              notDependOnLibsWithTags: ["env:server"],
              bannedExternalImports: ["pg", "node-pg-*"],
              allowedExternalImports: ["zod"],
            },
          ],
          allow: ["@ws/special"],
          allowCircularSelfDependency: true,
          enforceBuildableLibDependency: true,
          checkNestedImports: true,
        },
      },
      projects: [{ id: "ui", root: "libs/ui", tags: ["env:browser"] }],
      tasks: [
        {
          id: "ui:test",
          project: "ui",
          kind: "test",
          execution: { executable: "true" },
          impact: { mode: "project" },
        },
      ],
    });
    const manifest = parseTestingManifest(text, "dads.testing.json");
    expect(manifest.workspace.boundaries?.depConstraints?.[0]?.sourceTag).toBe("env:browser");
    expect(manifest.workspace.boundaries?.allow).toEqual(["@ws/special"]);
    expect(manifest.workspace.boundaries?.allowCircularSelfDependency).toBe(true);
    expect(manifest.workspace.boundaries?.enforceBuildableLibDependency).toBe(true);
    expect(manifest.workspace.boundaries?.checkNestedImports).toBe(true);
    expect(manifest.projects[0]?.tags).toEqual(["env:browser"]);
    expect(parseTestingManifest(serializeTestingManifest(manifest), "round-trip")).toEqual(manifest);

    expect(() =>
      parseTestingManifest(text.replace('"checkNestedImports":true', '"unknownBoundaryKey":true'), "dads.testing.json"),
    ).toThrow(/unknown key "unknownBoundaryKey"/);
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-manifest-"));
  temporaryDirectories.push(directory);
  return directory;
}
