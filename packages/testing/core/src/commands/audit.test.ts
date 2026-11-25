import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli, type DadTestCliIo } from "../dad-test-cli.js";
import { isRecord } from "../parse-guards.js";
import { createFakeNativeBinary } from "../test-support/native-fixture.js";
import { parseTestingManifest, serializeTestingManifest } from "../testing-manifest.js";
import { collapseAuditImpactPaths } from "./audit-fix.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../..");
const binaryName = process.platform === "win32" ? "dad-test.exe" : "dad-test";
const nativeReleaseBinary = join(repoRoot, "target", "release", binaryName);
const nativeDebugBinary = join(repoRoot, "target", "debug", binaryName);
const nativeBinary = existsSync(nativeReleaseBinary) ? nativeReleaseBinary : nativeDebugBinary;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dads-audit-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeRel(root: string, rel: string, contents: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function initGitRepo(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Dads Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
}

function createHarness(
  cwd: string,
  explicitBinary: string,
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
    stdout: (text) => {
      stdoutChunks.push(text);
    },
    stderr: (text) => {
      stderrChunks.push(text);
    },
    nativeBinary: explicitBinary,
  };
  return {
    io,
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
}

function parseJsonEnvelope(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object, got: ${raw}`);
  }
  return parsed;
}

describe("collapseAuditImpactPaths", () => {
  it("collapses >= 3 sibling files in the same parent directory into <dir>/** while keeping smaller groups individual", () => {
    expect(
      collapseAuditImpactPaths([
        "fixtures/invoices/a.json",
        "fixtures/invoices/b.json",
        "fixtures/invoices/c.json",
        "fixtures/invoices/sub/d.json",
        "settings/flags.json",
        "settings/limits.json",
        "root-a.txt",
        "root-b.txt",
        "root-c.txt",
      ]),
    ).toEqual([
      "fixtures/invoices/**",
      "root-a.txt",
      "root-b.txt",
      "root-c.txt",
      "settings/flags.json",
      "settings/limits.json",
    ]);
  });
});

describe("manifest and CLI read-guard flags", () => {
  it("round-trips workspace.enforceDeclaredReads in testing-manifest", () => {
    const manifest = parseTestingManifest(
      JSON.stringify({
        schemaVersion: 1,
        workspace: {
          root: ".",
          fullFallback: { taskIds: ["web:test"] },
          enforceDeclaredReads: true,
        },
        projects: [{ id: "web", root: "apps/web", fallbackDependencies: [] }],
        tasks: [
          {
            id: "web:test",
            project: "web",
            kind: "test",
            execution: { executable: "node", args: ["--version"] },
            dependsOn: [],
            impact: { mode: "project", paths: [] },
          },
        ],
      }),
      "dads.testing.json",
    );
    expect(manifest.workspace.enforceDeclaredReads).toBe(true);
    const reserialized = serializeTestingManifest(manifest);
    expect(reserialized).toContain('"enforceDeclaredReads": true');
  });

  it("forwards --enforce-declared-reads and --no-enforce-declared-reads on plan and run", async () => {
    const dir = makeTempDir();
    const fixture = createFakeNativeBinary(dir, {
      schemaVersion: 1,
      ok: true,
      result: {
        operation: "plan",
        plan: {
          schemaVersion: 1,
          scope: { kind: "working-tree", changedPaths: [], fullFallback: false },
          tasks: [],
          issues: [],
          complete: true,
          counts: { run: 0, skipProvenUnaffected: 0 },
        },
      },
    });
    const h1 = createHarness(dir, fixture.binary);
    expect(await runDadTestCli(["plan", "--enforce-declared-reads", "--json"], h1.io)).toBe(0);
    expect(fixture.readRequest()).toMatchObject({ enforceDeclaredReads: true });

    const h2 = createHarness(dir, fixture.binary);
    expect(
      await runDadTestCli(["plan", "--enforce-declared-reads", "--no-enforce-declared-reads", "--json"], h2.io),
    ).toBe(0);
    const req2 = fixture.readRequest();
    expect(req2).toMatchObject({ noEnforceDeclaredReads: true });
    expect(req2).not.toHaveProperty("enforceDeclaredReads");
  });
});

describe.skipIf(!existsSync(nativeBinary))("dad-test audit end-to-end with native engine", () => {
  function setupTwoProjectStaticWorkspace(): string {
    const root = makeTempDir();
    writeRel(root, "package.json", JSON.stringify({ name: "audit-fixture" }));
    writeRel(root, "static-known/ok.json", '{"static":true}');
    writeRel(root, "fixtures/invoices/inv-1.json", '{"id":1}');
    writeRel(root, "fixtures/invoices/inv-2.json", '{"id":2}');
    writeRel(root, "fixtures/invoices/inv-3.json", '{"id":3}');
    writeRel(root, "settings/web-flag.json", '{"flag":true}');
    writeRel(root, "settings/api-secret.json", '{"key":"v1"}');
    writeRel(
      root,
      "apps/web/src/web.test.mjs",
      [
        'import { readFileSync } from "node:fs";',
        "// Static literal read is resolved by Oxc and must NOT be flagged as undeclared:",
        'readFileSync("static-known/ok.json", "utf8");',
        "// Dynamic runtime reads cannot be resolved statically and MUST be reported by audit:",
        "const dynamicPaths = process.env.WEB_DYNAMIC_FILES ? JSON.parse(process.env.WEB_DYNAMIC_FILES) : [];",
        'for (const p of dynamicPaths) readFileSync(p, "utf8");',
      ].join("\n"),
    );
    writeRel(
      root,
      "apps/api/src/api.test.mjs",
      [
        'import { readFileSync } from "node:fs";',
        "const target = process.env.API_SECRET_PATH;",
        'if (target) readFileSync(target, "utf8");',
      ].join("\n"),
    );
    writeRel(
      root,
      "dads.testing.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          workspace: { root: ".", fullFallback: { taskIds: ["api:test", "web:test"] } },
          projects: [
            { id: "api", root: "apps/api", fallbackDependencies: [] },
            { id: "web", root: "apps/web", fallbackDependencies: [] },
          ],
          tasks: [
            {
              id: "api:test",
              project: "api",
              kind: "test",
              execution: {
                executable: process.execPath,
                args: ["apps/api/src/api.test.mjs"],
                env: { API_SECRET_PATH: "settings/api-secret.json" },
              },
              dependsOn: [],
              impact: { mode: "reachability", paths: [] },
            },
            {
              id: "web:test",
              project: "web",
              kind: "test",
              execution: {
                executable: process.execPath,
                args: ["apps/web/src/web.test.mjs"],
                env: {
                  WEB_DYNAMIC_FILES: JSON.stringify([
                    "fixtures/invoices/inv-1.json",
                    "fixtures/invoices/inv-2.json",
                    "fixtures/invoices/inv-3.json",
                    "settings/web-flag.json",
                  ]),
                },
              },
              dependsOn: [],
              impact: { mode: "reachability", paths: [] },
            },
          ],
        },
        null,
        2,
      ),
    );
    initGitRepo(root);
    return root;
  }

  it("reports undeclared reads, supports --project/--task scoping, collapses >= 3 siblings, and applies --fix safely", async () => {
    const root = setupTwoProjectStaticWorkspace();

    // Scoped --project web only audits web:test and collapses fixtures/invoices/*.
    const scopedHarness = createHarness(root, nativeBinary);
    expect(await runDadTestCli(["audit", "--project", "web", "--json"], scopedHarness.io)).toBe(0);
    const scopedEnvelope = parseJsonEnvelope(scopedHarness.stdout());
    expect(scopedEnvelope["ok"]).toBe(true);
    const scopedResult = scopedEnvelope["result"];
    expect(scopedResult).toMatchObject({
      mode: "report",
      auditedTasks: 1,
      tasksWithUndeclaredReads: 1,
      totalUndeclaredReads: 4,
      fixed: false,
      findings: [
        {
          taskId: "web:test",
          project: "web",
          suggestedImpactPaths: ["fixtures/invoices/**", "settings/web-flag.json"],
        },
      ],
    });

    // Scoped --task api:test only audits api:test.
    const taskHarness = createHarness(root, nativeBinary);
    expect(await runDadTestCli(["audit", "--task", "api:test", "--json"], taskHarness.io)).toBe(0);
    const taskEnvelope = parseJsonEnvelope(taskHarness.stdout());
    expect(taskEnvelope["result"]).toMatchObject({
      auditedTasks: 1,
      findings: [{ taskId: "api:test", suggestedImpactPaths: ["settings/api-secret.json"] }],
    });

    // --fix --dry-run computes changes without modifying dads.testing.json on disk.
    const beforeManifest = readFileSync(join(root, "dads.testing.json"), "utf8");
    const dryHarness = createHarness(root, nativeBinary);
    expect(await runDadTestCli(["audit", "--fix", "--dry-run", "--json"], dryHarness.io)).toBe(0);
    const dryEnvelope = parseJsonEnvelope(dryHarness.stdout());
    expect(dryEnvelope["result"]).toMatchObject({
      mode: "dry-run",
      fixed: false,
      changes: {
        "api:test": ["settings/api-secret.json"],
        "web:test": ["fixtures/invoices/**", "settings/web-flag.json"],
      },
    });
    expect(readFileSync(join(root, "dads.testing.json"), "utf8")).toBe(beforeManifest);

    // --fix writes validated manifest atomically; enforced run then passes cleanly.
    const fixHarness = createHarness(root, nativeBinary);
    expect(await runDadTestCli(["audit", "--fix"], fixHarness.io)).toBe(0);
    expect(fixHarness.stdout()).toContain("Updated dads.testing.json");

    const updatedManifest = parseTestingManifest(
      readFileSync(join(root, "dads.testing.json"), "utf8"),
      "dads.testing.json",
    );
    const webTask = updatedManifest.tasks.find((t) => t.id === "web:test");
    const apiTask = updatedManifest.tasks.find((t) => t.id === "api:test");
    expect(webTask?.impact.paths).toEqual(["fixtures/invoices/**", "settings/web-flag.json"]);
    expect(apiTask?.impact.paths).toEqual(["settings/api-secret.json"]);

    const enforceHarness = createHarness(root, nativeBinary);
    expect(await runDadTestCli(["run", "--all", "--enforce-declared-reads", "--json"], enforceHarness.io)).toBe(0);
    const enforceEnvelope = parseJsonEnvelope(enforceHarness.stdout());
    expect(enforceEnvelope["ok"]).toBe(true);
  });

  it("patches workspace.discover.taskOverrides on --fix without flattening declarative discover manifests", async () => {
    const root = makeTempDir();
    writeRel(root, "package.json", JSON.stringify({ name: "discover-audit-fixture" }));
    writeRel(root, "shared-config/flags.json", '{"ok":true}');
    writeRel(
      root,
      "packages/web/package.json",
      JSON.stringify({ name: "@app/web", scripts: { test: "node test.mjs" } }),
    );
    writeRel(
      root,
      "packages/web/src/web.test.mjs",
      [
        'import { readFileSync } from "node:fs";',
        "const target = process.env.DISCOVER_SECRET_PATH;",
        'if (target) readFileSync(target, "utf8");',
      ].join("\n"),
    );
    writeRel(
      root,
      "dads.testing.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          workspace: {
            root: ".",
            fullFallback: { taskIds: [] },
            discover: {
              projectFiles: ["packages/*/package.json"],
              targetTemplates: [
                {
                  target: "test",
                  kind: "test",
                  execution: {
                    executable: process.execPath,
                    args: ["{projectRoot}/src/web.test.mjs"],
                    env: { DISCOVER_SECRET_PATH: "shared-config/flags.json" },
                  },
                  impact: { mode: "reachability", paths: [] },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );
    initGitRepo(root);

    const fixHarness = createHarness(root, nativeBinary);
    expect(await runDadTestCli(["audit", "--fix", "--json"], fixHarness.io)).toBe(0);
    const fixEnvelope = parseJsonEnvelope(fixHarness.stdout());
    expect(fixEnvelope["result"]).toMatchObject({
      mode: "fix",
      fixed: true,
      changes: { "app-web:test": ["shared-config/flags.json"] },
    });

    const rawUpdated: unknown = JSON.parse(readFileSync(join(root, "dads.testing.json"), "utf8"));
    expect(rawUpdated).toMatchObject({
      workspace: {
        discover: {
          projectFiles: ["packages/*/package.json"],
          taskOverrides: [
            {
              target: "test",
              when: { projects: ["app-web"] },
              addImpactPaths: ["shared-config/flags.json"],
            },
          ],
        },
      },
    });

    const enforceHarness = createHarness(root, nativeBinary);
    expect(await runDadTestCli(["run", "--all", "--enforce-declared-reads", "--json"], enforceHarness.io)).toBe(0);
  });

  it("keeps --enforce-declared-reads overhead low across 250+ workspace file reads", async () => {
    const root = makeTempDir();
    writeRel(root, "package.json", JSON.stringify({ name: "bench-fixture" }));
    const fileCount = 250;
    const iterations = 40;
    for (let i = 0; i < fileCount; i += 1) {
      writeRel(root, `apps/bench/fixtures/f-${String(i).padStart(3, "0")}.txt`, `payload-${String(i)}\n`);
    }
    writeRel(
      root,
      "apps/bench/run.test.mjs",
      [
        'import { readFileSync } from "node:fs";',
        `const files = Array.from({ length: ${String(fileCount)} }, (_, i) => \`apps/bench/fixtures/f-\${String(i).padStart(3, "0")}.txt\`);`,
        "let total = 0;",
        `for (let round = 0; round < ${String(iterations)}; round += 1) {`,
        "  for (const file of files) {",
        '    total += readFileSync(file, "utf8").length;',
        "  }",
        "}",
        "if (total === 0) process.exit(1);",
      ].join("\n"),
    );
    writeRel(
      root,
      "dads.testing.json",
      JSON.stringify({
        schemaVersion: 1,
        workspace: { root: ".", fullFallback: { taskIds: ["bench:test"] } },
        projects: [{ id: "bench", root: "apps/bench", fallbackDependencies: [] }],
        tasks: [
          {
            id: "bench:test",
            project: "bench",
            kind: "test",
            execution: { executable: process.execPath, args: ["apps/bench/run.test.mjs"] },
            dependsOn: [],
            impact: { mode: "project", paths: [] },
          },
        ],
      }),
    );
    initGitRepo(root);

    const measure = async (enforce: boolean): Promise<number> => {
      const samples: number[] = [];
      for (let run = 0; run < 3; run += 1) {
        const harness = createHarness(root, nativeBinary);
        const args = [
          "run",
          "--only",
          "--task",
          "bench:test",
          "--json",
          ...(enforce ? ["--enforce-declared-reads"] : []),
        ];
        const started = performance.now();
        const code = await runDadTestCli(args, harness.io);
        const elapsed = performance.now() - started;
        expect(code).toBe(0);
        samples.push(elapsed);
      }
      samples.sort((a, b) => a - b);
      return samples[1] ?? samples[0] ?? 0;
    };

    // Warm up OS file cache once before measuring.
    await measure(false);
    const baselineMs = await measure(false);
    const enforcedMs = await measure(true);
    const deltaMs = enforcedMs - baselineMs;
    const deltaPct = baselineMs > 0 ? (deltaMs / baselineMs) * 100 : 0;

    process.stdout.write(
      `[read-guard-bench] ${String(fileCount * iterations)} reads across ${String(fileCount)} files: baseline=${baselineMs.toFixed(1)}ms, enforced=${enforcedMs.toFixed(1)}ms, delta=${deltaMs >= 0 ? "+" : ""}${deltaMs.toFixed(1)}ms (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)\n`,
    );

    // Preload + memoized O(1) hot path across 10,000 reads across 250 files stays well within budget.
    expect(deltaMs).toBeLessThan(200);
  }, 30_000);
});
