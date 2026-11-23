#!/usr/bin/env node
/**
 * Layer 1 verification: Differential oracle test comparing the formally proven
 * Lean 4 specification (`dad-test-oracle --json`) against the real Rust engine
 * (`dad-test`) on the exact same TypeScript workspaces, plus boundary checks
 * for zero-export test edits, setupFiles widening, escaped namespace imports,
 * and unowned-path full fallback.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUST_BIN = resolveRustBinary();
const LEAN_BIN = join(REPO_ROOT, "proofs", "dad-test", ".lake", "build", "bin", "dad-test-oracle");

function resolveRustBinary() {
  const release = join(REPO_ROOT, "target", "release", "dad-test");
  if (existsSync(release)) return release;
  const debug = join(REPO_ROOT, "target", "debug", "dad-test");
  if (existsSync(debug)) return debug;
  throw new Error("Missing dad-test binary. Run `cargo build --release -p dad-test` first.");
}

function runLeanOracle() {
  if (!existsSync(LEAN_BIN)) {
    throw new Error(`Missing Lean 4 oracle binary at ${LEAN_BIN}. Run \`lake build\` in proofs/dad-test.`);
  }
  const result = spawnSync(LEAN_BIN, ["--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Lean 4 oracle failed (${String(result.status)}):\n${result.stderr}\n${result.stdout}`);
  }
  return JSON.parse(result.stdout.trim());
}

function runRustPlan(workspaceRoot) {
  const request = JSON.stringify({
    schemaVersion: 1,
    operation: "plan",
    workspaceRoot,
    manifestPath: "dads.testing.json",
    all: false,
    taskIds: [],
  });
  const result = spawnSync(RUST_BIN, [], { input: request, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`dad-test exited ${String(result.status)}:\n${result.stderr}\n${result.stdout}`);
  }
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, `dad-test returned error: ${JSON.stringify(envelope)}`);
  return envelope.result.plan;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function createWorkspace(files) {
  const dir = mkdtempSync(join(tmpdir(), "dad-diff-oracle-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(dir, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  git(dir, ["init", "-q"]);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=DiffOracle", "-c", "user.email=oracle@example.invalid", "commit", "-qm", "baseline"]);
  return dir;
}

function taskSummary(plan, taskId) {
  const task = plan.tasks.find((entry) => entry.id === taskId);
  assert.ok(task, `Missing task ${taskId} in Rust plan`);
  return {
    decision: task.decision,
    widened: task.widened,
    selectedFiles: [...(task.selectedFiles ?? [])].sort(),
  };
}

function normalizeOracleTask(entry) {
  return {
    decision: entry.decision,
    widened: entry.widened,
    selectedFiles: [...(entry.selectedFiles ?? [])].sort(),
  };
}

const baseFiles = {
  "package.json": JSON.stringify({ name: "diff-oracle-fixture", type: "module" }, null, 2) + "\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext" } }, null, 2) + "\n",
  "vitest.config.ts": "export default {};\n",
  "dads.testing.json":
    JSON.stringify(
      {
        schemaVersion: 1,
        workspace: {
          root: ".",
          fullFallback: { taskIds: ["domains-a:unit", "domains-a:typecheck"] },
        },
        projects: [{ id: "domains-a", root: "domains/a", fallbackDependencies: [] }],
        tasks: [
          {
            id: "domains-a:unit",
            project: "domains-a",
            kind: "test",
            execution: {
              executable: "node",
              args: ["-e", "process.exit(0)"],
              fileNarrowing: {
                suffixes: [".test.ts"],
                setupFiles: ["vitest.config.ts"],
              },
            },
            dependsOn: [],
            impact: { mode: "reachability", paths: [] },
          },
          {
            id: "domains-a:typecheck",
            project: "domains-a",
            kind: "typecheck",
            execution: {
              executable: "node",
              args: ["-e", "process.exit(0)"],
              fileNarrowing: {
                suffixes: [".test.ts"],
                setupFiles: ["vitest.config.ts"],
              },
            },
            dependsOn: [],
            impact: { mode: "reachability", paths: [] },
          },
        ],
      },
      null,
      2,
    ) + "\n",
  "domains/a/foo.ts": "export const foo = () => 1;\n",
  "domains/a/bar.ts": "export const bar = () => 2;\n",
  "domains/a/barrel.ts": 'export * from "./foo.js";\nexport * from "./bar.js";\n',
  "domains/a/mid.ts": [
    'import { bar } from "./barrel.js";',
    "export const usesBar = () => bar() + 10;",
    "export const unrelated = () => 99;",
    "",
  ].join("\n"),
  "domains/a/usesBar.test.ts": [
    'import { usesBar } from "./mid.js";',
    "if (usesBar() !== 12) throw new Error('bad');",
    "",
  ].join("\n"),
  "domains/a/unrelated.test.ts": [
    'import { unrelated } from "./mid.js";',
    "if (unrelated() !== 99) throw new Error('bad');",
    "",
  ].join("\n"),
  "domains/a/typeConsumer.test.ts": [
    'import type { usesBar } from "./mid.js";',
    "type Fn = typeof usesBar;",
    "const check: Fn | null = null;",
    "void check;",
    "",
  ].join("\n"),
  "domains/a/nsConsumer.test.ts": [
    'import * as mid from "./mid.js";',
    "if (mid.usesBar() !== 12) throw new Error('bad');",
    "",
  ].join("\n"),
  "domains/a/commentOnly.ts": "export const stable = 42;\n",
};

const oracle = runLeanOracle();
const tempDirs = [];

try {
  // Case 1: Diamond `export *` + intra-file def-use + `import type` + tracked namespace
  const dir1 = createWorkspace(baseFiles);
  tempDirs.push(dir1);
  writeFileSync(join(dir1, "domains/a/foo.ts"), "export const foo = () => 101;\n", "utf8");
  writeFileSync(join(dir1, "domains/a/bar.ts"), "export const bar = () => 202;\n", "utf8");
  const rustDiamond = runRustPlan(dir1);

  assert.deepEqual(
    taskSummary(rustDiamond, "domains-a:unit"),
    normalizeOracleTask(oracle.diamond["domains-a:unit"]),
    "Rust runtime unit decision must match Lean 4 oracle on diamond + import type + tracked namespace",
  );
  // Typecheck channel stays conservatively sound on `import type` (runs full typecheck).
  const rustTypecheck = taskSummary(rustDiamond, "domains-a:typecheck");
  const oracleTypecheck = normalizeOracleTask(oracle.diamond["domains-a:typecheck"]);
  assert.equal(rustTypecheck.decision, oracleTypecheck.decision);
  assert.equal(rustTypecheck.decision, "run");
  process.stdout.write(
    `${"PASS [1/6] Lean 4 <-> Rust exact parity: diamond export*, intra-file def-use, import type erasure, tracked namespace"}\n`,
  );

  // Case 2: Comment-only edit -> zero tasks run (matches Lean 4 Theorem 7)
  const dir2 = createWorkspace(baseFiles);
  tempDirs.push(dir2);
  writeFileSync(join(dir2, "domains/a/commentOnly.ts"), "// purely documentation\nexport const stable = 42;\n", "utf8");
  const rustComment = runRustPlan(dir2);

  assert.deepEqual(
    taskSummary(rustComment, "domains-a:unit"),
    normalizeOracleTask(oracle.commentOnly["domains-a:unit"]),
    "Rust must match Lean 4 oracle: comment-only edit skips runtime unit task",
  );
  assert.deepEqual(
    taskSummary(rustComment, "domains-a:typecheck"),
    normalizeOracleTask(oracle.commentOnly["domains-a:typecheck"]),
    "Rust must match Lean 4 oracle: comment-only edit skips typecheck task",
  );
  process.stdout.write(`${"PASS [2/6] Lean 4 <-> Rust exact parity: comment-only edit runs 0 tests"}\n`);

  // Case 3: Zero-export leaf test edit -> selects ONLY that single test file, zero widening
  const dir3 = createWorkspace(baseFiles);
  tempDirs.push(dir3);
  writeFileSync(
    join(dir3, "domains/a/unrelated.test.ts"),
    'import { unrelated } from "./mid.js";\nif (unrelated() !== 99) throw new Error("updated");\n',
    "utf8",
  );
  const rustLeafTest = runRustPlan(dir3);
  assert.deepEqual(taskSummary(rustLeafTest, "domains-a:unit"), {
    decision: "run",
    widened: false,
    selectedFiles: ["domains/a/unrelated.test.ts"],
  });
  process.stdout.write(`${"PASS [3/6] Leaf zero-export .test.ts edit selects only itself with widened=false"}\n`);

  // Case 4: Editing declared setupFiles (`vitest.config.ts`) forces safe fallback/un-narrowed execution
  const dir4 = createWorkspace(baseFiles);
  tempDirs.push(dir4);
  writeFileSync(join(dir4, "vitest.config.ts"), "export default { test: { globals: false } };\n", "utf8");
  const rustSetup = runRustPlan(dir4);
  assert.equal(rustSetup.tasks.find((t) => t.id === "domains-a:unit")?.decision, "run");
  assert.deepEqual(rustSetup.tasks.find((t) => t.id === "domains-a:unit")?.selectedFiles ?? [], []);
  process.stdout.write(`${"PASS [4/6] setupFiles edit safely disables file narrowing (runs full task)"}\n`);

  // Case 5: Escaped namespace import (`Object.keys(mid)`) must widen soundly
  const dir5 = createWorkspace({
    ...baseFiles,
    "domains/a/nsConsumer.test.ts":
      'import * as mid from "./mid.js";\nprocess.stdout.write(`${Object.keys(mid)}\n`);\n',
  });
  tempDirs.push(dir5);
  writeFileSync(join(dir5, "domains/a/bar.ts"), "export const bar = () => 999;\n", "utf8");
  const rustEscapedNs = runRustPlan(dir5);
  assert.equal(rustEscapedNs.tasks.find((t) => t.id === "domains-a:unit")?.decision, "run");
  assert.equal(rustEscapedNs.tasks.find((t) => t.id === "domains-a:unit")?.widened, true);
  process.stdout.write(`${"PASS [5/6] Escaped namespace import soundly widens (widened=true)"}\n`);

  // Case 6: Unowned changed path outside manifest projects forces full fallback
  const dir6 = createWorkspace(baseFiles);
  tempDirs.push(dir6);
  writeFileSync(join(dir6, "global-config.json"), '{"flag":true}\n', "utf8");
  const rustUnowned = runRustPlan(dir6);
  assert.equal(rustUnowned.scope.fullFallback, true);
  assert.equal(rustUnowned.counts.run, 2);
  process.stdout.write(`${"PASS [6/6] Unowned path outside declared projects forces fullFallback=true"}\n`);

  process.stdout.write(`${"\nLayer 1 Differential Oracle: 6/6 checks passed (100% Lean 4 <-> Rust parity)."}\n`);
} finally {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}
