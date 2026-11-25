import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../parse-guards.js";
import { runDadTestCli, type DadTestCliIo } from "../dad-test-cli.js";
import { createFakeNativeBinary } from "../test-support/native-fixture.js";
import type { TestingBoundariesResult } from "../testing-api.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../..");
const nativeDebugBinary = join(repoRoot, "target", "debug", process.platform === "win32" ? "dad-test.exe" : "dad-test");

const emptyPlan = {
  schemaVersion: 1,
  scope: { kind: "check-boundaries", changedPaths: [], fullFallback: false },
  tasks: [],
  issues: [],
  complete: true,
  counts: { run: 0, skipProvenUnaffected: 0 },
};

describe("dad-test check-boundaries CLI", () => {
  it("forwards --base, --head, --config, and --manifest to the native engine and exits 0 when clean", async () => {
    const dir = makeTempDir();
    const boundariesResult: TestingBoundariesResult = {
      schemaVersion: 1,
      checkedFiles: 4,
      totalProjects: 2,
      violations: [],
    };
    const fixture = createFakeNativeBinary(dir, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "check-boundaries", plan: emptyPlan, boundaries: boundariesResult },
    });
    const harness = createHarness(dir, fixture.binary);

    const exitCode = await runDadTestCli(
      [
        "check-boundaries",
        "--base",
        "origin/main",
        "--head",
        "HEAD",
        "--config",
        "boundaries.json",
        "--manifest",
        "custom.json",
        "--json",
      ],
      harness.io,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr()).toBe("");
    expect(JSON.parse(harness.stdout())).toEqual({ schemaVersion: 1, ok: true, result: boundariesResult });
    expect(fixture.readRequest()).toEqual({
      schemaVersion: 1,
      operation: "check-boundaries",
      workspaceRoot: dir,
      manifestPath: "custom.json",
      base: "origin/main",
      head: "HEAD",
      boundariesConfigPath: "boundaries.json",
      all: false,
      taskIds: [],
    });
  });

  it("renders human violations and exits 1 when violations are present", async () => {
    const dir = makeTempDir();
    const boundariesResult: TestingBoundariesResult = {
      schemaVersion: 1,
      checkedFiles: 3,
      totalProjects: 2,
      violations: [
        {
          file: "libs/ui/src/index.ts",
          line: 2,
          column: 20,
          sourceProject: "ui",
          targetProject: "server",
          specifier: "@ws/server",
          rule: "not-depend-on-libs-with-tags",
          message: 'A project tagged with "env:browser" cannot depend on libs tagged with "env:server".',
        },
        {
          file: "libs/ui/src/index.ts",
          line: 3,
          column: 16,
          sourceProject: "ui",
          specifier: "pg",
          rule: "banned-external-import",
          message: 'A project tagged with "env:browser" cannot import external package "pg".',
        },
      ],
    };
    const fixture = createFakeNativeBinary(dir, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "check-boundaries", plan: emptyPlan, boundaries: boundariesResult },
    });
    const harness = createHarness(dir, fixture.binary);

    const exitCode = await runDadTestCli(["check-boundaries"], harness.io);

    expect(exitCode).toBe(1);
    expect(harness.stderr()).toBe("");
    expect(harness.stdout()).toContain("libs/ui/src/index.ts:2:20 [not-depend-on-libs-with-tags] (ui -> server)");
    expect(harness.stdout()).toContain("libs/ui/src/index.ts:3:16 [banned-external-import] (ui -> external)");
    expect(harness.stdout()).toContain("check-boundaries: 2 violations across 3 files (2 projects).");
  });

  it.skipIf(!existsSync(nativeDebugBinary))(
    "enforces boundaries end-to-end via the native Rust binary including --base and --config",
    async () => {
      const dir = makeTempDir();
      mkdirSync(join(dir, "libs/ui/src"), { recursive: true });
      mkdirSync(join(dir, "libs/server/src"), { recursive: true });
      mkdirSync(join(dir, "libs/shared/src"), { recursive: true });

      writeFileSync(
        join(dir, "tsconfig.base.json"),
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@ws/ui": ["libs/ui/src/index.ts"],
              "@ws/server": ["libs/server/src/index.ts"],
              "@ws/shared": ["libs/shared/src/index.ts"],
            },
          },
        }),
      );
      writeFileSync(join(dir, "libs/ui/project.json"), JSON.stringify({ name: "ui", tags: ["env:browser"] }));
      writeFileSync(join(dir, "libs/server/project.json"), JSON.stringify({ name: "server", tags: ["env:server"] }));
      writeFileSync(join(dir, "libs/shared/project.json"), JSON.stringify({ name: "shared", tags: ["shared"] }));
      writeFileSync(
        join(dir, "dads.testing.json"),
        JSON.stringify({
          schemaVersion: 1,
          workspace: {
            root: ".",
            fullFallback: { taskIds: ["ui:test"] },
            boundaries: {
              allow: ["@ws/exempted"],
              depConstraints: [
                {
                  sourceTag: "env:browser",
                  onlyDependOnLibsWithTags: ["env:browser", "shared"],
                  notDependOnLibsWithTags: ["env:server"],
                  bannedExternalImports: ["pg"],
                },
              ],
            },
          },
          projects: [
            { id: "ui", root: "libs/ui", fallbackDependencies: [] },
            { id: "server", root: "libs/server", fallbackDependencies: [] },
            { id: "shared", root: "libs/shared", fallbackDependencies: [] },
          ],
          tasks: [
            {
              id: "ui:test",
              project: "ui",
              kind: "test",
              execution: { executable: "node", args: ["-e", "process.exit(0)"] },
              dependsOn: [],
              impact: { mode: "project" },
            },
          ],
        }),
      );

      writeFileSync(join(dir, "libs/shared/src/index.ts"), "export const shared = 1;\n");
      writeFileSync(join(dir, "libs/server/src/index.ts"), "export const server = 2;\n");
      writeFileSync(
        join(dir, "libs/ui/src/index.ts"),
        'import { shared } from "@ws/shared";\nimport { ex } from "@ws/exempted";\nexport const ok = [shared, ex];\n',
      );
      writeFileSync(
        join(dir, "libs/ui/src/legacy.ts"),
        'import { server } from "@ws/server";\nimport pg from "pg";\nimport { ok } from "@ws/ui";\nexport const bad = [server, pg, ok];\n',
      );

      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "test@dads.invalid"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Dads Test"], { cwd: dir });
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: dir });

      // Full workspace check reports legacy.ts violations (tag, not-tag, banned external, circular self-dep).
      const fullHarness = createHarness(dir, nativeDebugBinary);
      const fullCode = await runDadTestCli(["check-boundaries", "--json"], fullHarness.io);
      expect(fullCode).toBe(1);
      const fullEnvelope = parseBoundariesEnvelope(fullHarness.stdout());
      expect(fullEnvelope.ok).toBe(true);
      const rules = fullEnvelope.result.violations.map((v) => v.rule);
      expect(rules).toContain("only-depend-on-libs-with-tags");
      expect(rules).toContain("not-depend-on-libs-with-tags");
      expect(rules).toContain("banned-external-import");
      expect(rules).toContain("circular-self-dependency");

      // Edit only the clean file and run with --base HEAD -> 0 violations.
      writeFileSync(
        join(dir, "libs/ui/src/index.ts"),
        'import { shared } from "@ws/shared";\nimport { ex } from "@ws/exempted";\nexport const ok = [shared, ex, 1];\n',
      );
      const baseHarness = createHarness(dir, nativeDebugBinary);
      const baseCode = await runDadTestCli(["check-boundaries", "--base", "HEAD", "--json"], baseHarness.io);
      expect(baseCode).toBe(0);
      const baseEnvelope = parseBoundariesEnvelope(baseHarness.stdout());
      expect(baseEnvelope.result.violations).toEqual([]);
      expect(baseEnvelope.result.checkedFiles).toBe(1);
    },
  );
});

function parseBoundariesEnvelope(raw: string): {
  readonly ok: boolean;
  readonly result: {
    readonly checkedFiles: number;
    readonly violations: readonly { readonly rule: string }[];
  };
} {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed["ok"] !== "boolean" || !isRecord(parsed["result"])) {
    throw new Error(`Invalid boundaries envelope: ${raw}`);
  }
  const result = parsed["result"];
  const rawViolations = result["violations"];
  if (typeof result["checkedFiles"] !== "number" || !Array.isArray(rawViolations)) {
    throw new Error(`Invalid boundaries result: ${raw}`);
  }
  const violations: { readonly rule: string }[] = [];
  for (const item of rawViolations) {
    if (isRecord(item) && typeof item["rule"] === "string") {
      violations.push({ rule: item["rule"] });
    }
  }
  return {
    ok: parsed["ok"],
    result: { checkedFiles: result["checkedFiles"], violations },
  };
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dads-testing-boundaries-cli-"));
  tempDirs.push(dir);
  return dir;
}

function createHarness(
  cwd: string,
  nativeBinary: string,
): {
  readonly io: DadTestCliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const io: DadTestCliIo = {
    cwd,
    env: {},
    stdout: (text) => stdoutChunks.push(text),
    stderr: (text) => stderrChunks.push(text),
    nativeBinary,
  };
  return {
    io,
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
}
