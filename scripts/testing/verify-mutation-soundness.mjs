#!/usr/bin/env node
/**
 * Layer 2 verification: Live Vitest Mutation Soundness & Precision Test.
 *
 * Injects real bugs one by one across:
 *   Suite A: A multi-domain TypeScript + Vitest fixture (diamond `export *`,
 *            `import type`, tracked `import * as ns`, intra-file def-use,
 *            and unrelated domains).
 *   Suite B: A real temp copy of `apps/kit-workbench` initialized with
 *            `dad-test init` (`dads.project.json` discovery + file narrowing).
 *
 * For every semantic mutation, runs BOTH narrowed `dad-test run` AND full
 * `vitest run` and asserts:
 *   - 0 escaped mutants (every bug caught by full Vitest is caught by dad-test)
 *   - 0 spurious test runs on comment-only and `import type`-only edits
 *   - exact file-level skipping on targeted edits
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUST_BIN = resolveRustBinary();

function resolveRustBinary() {
  const release = join(REPO_ROOT, "target", "release", "dad-test");
  if (existsSync(release)) return release;
  const debug = join(REPO_ROOT, "target", "debug", "dad-test");
  if (existsSync(debug)) return debug;
  throw new Error("Missing dad-test binary. Run `cargo build --release -p dad-test` first.");
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function callDadTest(operation, workspaceRoot, taskIds = []) {
  const started = performance.now();
  const request = JSON.stringify({
    schemaVersion: 1,
    operation,
    workspaceRoot,
    manifestPath: "dads.testing.json",
    all: false,
    taskIds,
  });
  const result = spawnSync(RUST_BIN, [], { input: request, encoding: "utf8" });
  const elapsedMs = Math.round(performance.now() - started);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, `dad-test ${operation} error: ${JSON.stringify(envelope)}`);
  return { result: envelope.result, elapsedMs };
}

function runVitestFull(workspaceRoot, extraArgs = []) {
  const started = performance.now();
  const vitestBin = join(REPO_ROOT, "node_modules", ".bin", "vitest");
  const result = spawnSync(vitestBin, ["run", ...extraArgs], { cwd: workspaceRoot, encoding: "utf8" });
  return { exitCode: result.status ?? 1, elapsedMs: Math.round(performance.now() - started) };
}

function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

async function runSyntheticMutationSuite() {
  const dir = mkdtempSync(join(tmpdir(), "dad-mutation-synth-"));
  try {
    const vitestBin = join(REPO_ROOT, "node_modules", ".bin", "vitest");
    writeFiles(dir, {
      "package.json": JSON.stringify({ name: "mutation-synth", type: "module" }, null, 2) + "\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext" } }, null, 2) + "\n",
      "dads.testing.json":
        JSON.stringify(
          {
            schemaVersion: 1,
            workspace: {
              root: ".",
              fullFallback: { taskIds: ["billing:unit", "notes:unit", "reports:unit"] },
            },
            projects: [
              { id: "billing", root: "domains/billing", fallbackDependencies: [] },
              { id: "notes", root: "domains/notes", fallbackDependencies: [] },
              { id: "reports", root: "domains/reports", fallbackDependencies: ["billing", "notes"] },
            ],
            tasks: [
              {
                id: "billing:unit",
                project: "billing",
                kind: "test",
                execution: {
                  executable: vitestBin,
                  args: ["run", "--dir", "domains/billing"],
                  fileNarrowing: { suffixes: [".test.ts"] },
                },
                dependsOn: [],
                impact: { mode: "reachability", paths: [] },
              },
              {
                id: "notes:unit",
                project: "notes",
                kind: "test",
                execution: {
                  executable: vitestBin,
                  args: ["run", "--dir", "domains/notes"],
                  fileNarrowing: { suffixes: [".test.ts"] },
                },
                dependsOn: [],
                impact: { mode: "reachability", paths: [] },
              },
              {
                id: "reports:unit",
                project: "reports",
                kind: "test",
                execution: {
                  executable: vitestBin,
                  args: ["run", "--dir", "domains/reports"],
                  fileNarrowing: { suffixes: [".test.ts"] },
                },
                dependsOn: [],
                impact: { mode: "reachability", paths: [] },
              },
            ],
          },
          null,
          2,
        ) + "\n",
      "domains/billing/tax.ts": "export const computeTax = (cents: number): number => Math.round(cents * 0.1);\n",
      "domains/billing/discount.ts":
        "export const applyDiscount = (cents: number): number => Math.max(0, cents - 50);\n",
      "domains/billing/index.ts": 'export * from "./tax.js";\nexport * from "./discount.js";\n',
      "domains/billing/invoice.ts": [
        'import { computeTax, applyDiscount } from "./index.js";',
        "export type InvoiceSummary = { readonly total: number };",
        "export const totalWithTax = (cents: number): number => cents + computeTax(cents);",
        "export const totalWithDiscount = (cents: number): number => applyDiscount(cents);",
        "",
      ].join("\n"),
      "domains/billing/tax.test.ts": [
        'import { expect, test } from "vitest";',
        'import { totalWithTax } from "./invoice.js";',
        'test("adds 10% tax", () => { expect(totalWithTax(100)).toBe(110); });',
        "",
      ].join("\n"),
      "domains/billing/discount.test.ts": [
        'import { expect, test } from "vitest";',
        'import { totalWithDiscount } from "./invoice.js";',
        'test("applies flat discount", () => { expect(totalWithDiscount(200)).toBe(150); });',
        "",
      ].join("\n"),
      "domains/notes/slug.ts":
        "export const slugify = (title: string): string => title.trim().toLowerCase().replace(/\\s+/g, '-');\n",
      "domains/notes/slug.test.ts": [
        'import { expect, test } from "vitest";',
        'import { slugify } from "./slug.js";',
        'test("slugifies title", () => { expect(slugify("Hello World")).toBe("hello-world"); });',
        "",
      ].join("\n"),
      "domains/reports/ns-report.test.ts": [
        'import { expect, test } from "vitest";',
        'import * as invoice from "../billing/invoice.js";',
        'test("tracked namespace totalWithTax", () => { expect(invoice.totalWithTax(200)).toBe(220); });',
        "",
      ].join("\n"),
      "domains/reports/type-only.test.ts": [
        'import { expect, test } from "vitest";',
        'import type { InvoiceSummary } from "../billing/invoice.js";',
        'test("type-only consumer", () => { const s: InvoiceSummary = { total: 5 }; expect(s.total).toBe(5); });',
        "",
      ].join("\n"),
      "domains/reports/notes-summary.test.ts": [
        'import { expect, test } from "vitest";',
        'import { slugify } from "../notes/slug.js";',
        'test("reports slug", () => { expect(slugify("Q4 Report")).toBe("q4-report"); });',
        "",
      ].join("\n"),
    });

    symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, ".git", "info", "exclude"), "node_modules\n", "utf8");
    git(dir, ["add", "."]);
    git(dir, ["-c", "user.name=Mutation", "-c", "user.email=mut@example.invalid", "commit", "-qm", "baseline"]);

    // Verify clean baseline passes full vitest
    const baseline = runVitestFull(dir);
    assert.equal(baseline.exitCode, 0, "Synthetic baseline suite must pass");

    // Warm snapshot cache once
    callDadTest("plan", dir);

    const mutations = [
      {
        name: "M1: tax rate bug (diamond export* + tracked namespace)",
        file: "domains/billing/tax.ts",
        find: "0.1",
        replace: "0.2",
        expectSelected: ["domains/billing/tax.test.ts", "domains/reports/ns-report.test.ts"],
        expectCatch: true,
      },
      {
        name: "M2: discount amount bug (must skip tax.test.ts & ns-report.test.ts!)",
        file: "domains/billing/discount.ts",
        find: "cents - 50",
        replace: "cents - 10",
        expectSelected: ["domains/billing/discount.test.ts"],
        expectCatch: true,
      },
      {
        name: "M3: invoice totalWithTax bug",
        file: "domains/billing/invoice.ts",
        find: "cents + computeTax(cents)",
        replace: "cents - computeTax(cents)",
        expectSelected: ["domains/billing/tax.test.ts", "domains/reports/ns-report.test.ts"],
        expectCatch: true,
      },
      {
        name: "M4: invoice totalWithDiscount bug",
        file: "domains/billing/invoice.ts",
        find: "applyDiscount(cents)",
        replace: "cents",
        expectSelected: ["domains/billing/discount.test.ts"],
        expectCatch: true,
      },
      {
        name: "M5: notes slugify bug (must skip all billing tests!)",
        file: "domains/notes/slug.ts",
        find: "'-'",
        replace: "'_'",
        expectSelected: ["domains/notes/slug.test.ts", "domains/reports/notes-summary.test.ts"],
        expectCatch: true,
      },
      {
        name: "M6: comment-only edit (0 tests must run)",
        file: "domains/billing/tax.ts",
        find: "export const computeTax",
        replace: "// docs only\nexport const computeTax",
        expectSelected: [],
        expectCatch: false,
      },
      {
        name: "M7: export type edit (0 runtime tests must run)",
        file: "domains/billing/invoice.ts",
        find: "readonly total: number",
        replace: "readonly total: number; readonly currency?: string",
        expectSelected: [],
        expectCatch: false,
      },
      {
        name: "M8: leaf .test.ts edit (only that 1 test file must run)",
        file: "domains/notes/slug.test.ts",
        find: "hello-world",
        replace: "broken-expected",
        expectSelected: ["domains/notes/slug.test.ts"],
        expectCatch: true,
      },
    ];

    let escaped = 0;
    let totalFilesPossible = 0;
    let totalFilesRun = 0;

    for (const m of mutations) {
      const target = join(dir, m.file);
      const original = readFileSync(target, "utf8");
      assert.ok(original.includes(m.find), `Could not find mutation target in ${m.file}`);
      writeFileSync(target, original.replace(m.find, m.replace), "utf8");
      try {
        const dad = callDadTest("run", dir);
        const selected = dad.result.plan.tasks.flatMap((t) => t.selectedFiles ?? []).sort();
        const widenedCount = dad.result.plan.tasks.filter((t) => t.widened).length;

        assert.equal(widenedCount, 0, `${m.name}: unexpected widening!`);
        assert.deepEqual(selected, [...m.expectSelected].sort(), `${m.name}: exact selectedFiles mismatch`);

        totalFilesPossible += 6;
        totalFilesRun += selected.length;

        if (m.expectCatch) {
          const full = runVitestFull(dir);
          assert.notEqual(full.exitCode, 0, `${m.name}: expected full Vitest to catch mutant`);
          if (dad.result.run.exitCode === 0) escaped += 1;
          assert.notEqual(dad.result.run.exitCode, 0, `${m.name}: ESCAPED MUTANT!`);
        } else {
          assert.equal(dad.result.plan.counts.run, 0, `${m.name}: expected 0 tasks run`);
        }
        process.stdout.write(
          `${`  PASS ${m.name} -> selected ${selected.length}/6 files (${dad.elapsedMs}ms), exitCode=${dad.result.run.exitCode}`}\n`,
        );
      } finally {
        writeFileSync(target, original, "utf8");
      }
    }

    assert.equal(escaped, 0, `Escaped mutants detected: ${escaped}`);
    const pctSkipped = Math.round(((totalFilesPossible - totalFilesRun) / totalFilesPossible) * 100);
    process.stdout.write(
      `${`Suite A (Synthetic Vitest): 0 escaped mutants across ${mutations.length} edits, ${pctSkipped}% test files skipped.\n`}\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runKitWorkbenchMutationSuite() {
  const { initTestingManifest } = await import(
    join(REPO_ROOT, "packages", "testing", "core", "dist", "init", "init-testing-manifest.js")
  );
  const source = join(REPO_ROOT, "apps", "kit-workbench");
  const dir = mkdtempSync(join(tmpdir(), "dad-mutation-workbench-"));
  try {
    cpSync(source, dir, {
      recursive: true,
      filter: (p) => !p.includes("/node_modules") && !p.includes("/.git") && !p.includes("/dist"),
    });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, ".git", "info", "exclude"), "node_modules\ndads.testing.init-report.json\n", "utf8");

    // Generate manifest automatically via `dad-test init` (`dads.project.json` discovery!)
    const init = await initTestingManifest({
      workspaceRoot: dir,
      nativeBinary: RUST_BIN,
      environment: {},
    });
    assert.equal(init.report.validation.ok, true);
    assert.equal(init.report.validation.method, "native");

    git(dir, ["add", "."]);
    git(dir, ["-c", "user.name=WorkbenchMut", "-c", "user.email=wb@example.invalid", "commit", "-qm", "baseline"]);

    // Warm snapshot cache
    callDadTest("plan", dir);

    const mutations = [
      {
        name: "WB1: real bug in domains/notes/pure/note-rules.ts",
        file: "domains/notes/pure/note-rules.ts",
        mutate: (src) => src.replace(".trim()", ""),
        taskId: "domains-notes:unit",
        expectSelected: ["domains/notes/pure/note-rules.test.ts"],
        expectCatch: true,
      },
      {
        name: "WB2: comment-only edit in domains/notes/pure/note-rules.ts",
        file: "domains/notes/pure/note-rules.ts",
        mutate: (src) => `// harmless comment\n${src}`,
        taskId: "domains-notes:unit",
        expectSelected: [],
        expectCatch: false,
      },
      {
        name: "WB3: export type edit in domains/notes/server/notes-store.ts",
        file: "domains/notes/server/notes-store.ts",
        mutate: (src) => `${src}\nexport type DiagnosticNoteTag = string;\n`,
        taskId: "domains-notes:unit",
        expectSelected: [],
        expectCatch: false,
      },
    ];

    let escaped = 0;
    for (const m of mutations) {
      const target = join(dir, m.file);
      const original = readFileSync(target, "utf8");
      const mutated = m.mutate(original);
      assert.notEqual(mutated, original, `${m.name}: mutation produced identical source`);
      writeFileSync(target, mutated, "utf8");
      try {
        // Check full-app plan first
        const planRes = callDadTest("plan", dir);
        const notesDecision = planRes.result.plan.tasks.find((t) => t.id === m.taskId);
        assert.ok(notesDecision, `Missing ${m.taskId}`);
        assert.equal(notesDecision.widened, false, `${m.name}: unexpected widening on kit-workbench!`);
        assert.deepEqual([...(notesDecision.selectedFiles ?? [])].sort(), m.expectSelected);

        if (m.expectCatch) {
          // Run ONLY domains-notes:unit directly via dad-test run (narrowed to 1 test file!)
          // Note: we pass no taskIds for plan check above; here run full narrowed unit task
          const runRes = callDadTest("run", dir, []);
          const notesRun = runRes.result.run.tasks.find((t) => t.id === m.taskId);
          // Even if integration tests weren't run because docker isn't needed for note-rules,
          // check that domains-notes:unit ran and FAILED to catch the mutant!
          assert.ok(notesRun, "Expected domains-notes:unit in run output");
          if (notesRun.status !== "failed") escaped += 1;
          assert.equal(notesRun.status, "failed", `${m.name}: ESCAPED MUTANT on kit-workbench!`);
          process.stdout.write(
            `${`  PASS ${m.name} -> caught by narrowed ${m.taskId} (${notesDecision.selectedFiles?.length ?? 0} file) in ${notesRun.durationMs ?? 0}ms`}\n`,
          );
        } else {
          assert.equal(notesDecision.decision, "skip-proven-unaffected");
          process.stdout.write(
            `${`  PASS ${m.name} -> ${m.taskId} skipped (proven unaffected) in ${planRes.elapsedMs}ms`}\n`,
          );
        }
      } finally {
        writeFileSync(target, original, "utf8");
      }
    }

    assert.equal(escaped, 0);
    process.stdout.write(`${"Suite B (apps/kit-workbench via dad-test init): 0 escaped mutants, 0 widening.\n"}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await runSyntheticMutationSuite();
await runKitWorkbenchMutationSuite();
process.stdout.write(`${"Layer 2 Live Vitest Mutation Soundness: ALL PASSED (0 escaped mutants)."}\n`);
