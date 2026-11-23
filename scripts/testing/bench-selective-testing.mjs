#!/usr/bin/env node
/**
 * Layer 4 benchmark: Real-world latency, precision (% test files skipped),
 * widening diagnostics, and narrowed-vs-full Vitest wall-clock comparison across:
 *   1. `apps/kit-workbench` (Dads app initialized via `dad-test init`)
 *   2. `dads-framework` (monorepo, 2,000+ TS files)
 *   3. `honojs/hono` and `colinhacks/zod` (large OSS TypeScript repos in /tmp)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUST_BIN = existsSync(join(REPO_ROOT, "target", "release", "dad-test"))
  ? join(REPO_ROOT, "target", "release", "dad-test")
  : join(REPO_ROOT, "target", "debug", "dad-test");
const VITEST_BIN = join(REPO_ROOT, "node_modules", ".bin", "vitest");

const log = (line = "") => process.stdout.write(`${line}\n`);

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${res.stderr}`);
  return res.stdout.trim();
}

function callDad(operation, workspaceRoot, extra = {}) {
  const started = performance.now();
  const req = {
    schemaVersion: 1,
    operation,
    workspaceRoot,
    manifestPath: "dads.testing.json",
    all: false,
    taskIds: [],
    ...extra,
  };
  const res = spawnSync(RUST_BIN, [], { input: JSON.stringify(req), encoding: "utf8" });
  const ms = Math.round(performance.now() - started);
  if (res.status !== 0 && operation === "plan") throw new Error(`dad-test plan failed:\n${res.stderr}`);
  const env = JSON.parse(res.stdout);
  assert.equal(env.ok, true, `dad-test error: ${JSON.stringify(env)}`);
  return { result: env.result, ms };
}

function countMatchingFiles(dir, predicate) {
  let count = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && predicate(full)) count += 1;
    }
  };
  walk(dir);
  return count;
}

async function benchKitWorkbench() {
  log("=== 1. apps/kit-workbench (Dads app via dad-test init) ===");
  const { initTestingManifest } = await import(
    join(REPO_ROOT, "packages", "testing", "core", "dist", "init", "init-testing-manifest.js")
  );
  const dir = mkdtempSync(join(tmpdir(), "dad-bench-wb-"));
  try {
    cpSync(join(REPO_ROOT, "apps", "kit-workbench"), dir, {
      recursive: true,
      filter: (p) => !p.includes("/node_modules") && !p.includes("/.git") && !p.includes("/dist"),
    });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, ".git", "info", "exclude"), "node_modules\ndads.testing.init-report.json\n", "utf8");
    await initTestingManifest({ workspaceRoot: dir, nativeBinary: RUST_BIN, environment: {} });
    git(dir, ["add", "."]);
    git(dir, ["-c", "user.name=Bench", "-c", "user.email=b@example.invalid", "commit", "-qm", "base"]);

    const totalTs = countMatchingFiles(dir, (p) => /\.(ts|tsx|mjs)$/.test(p));
    const totalTests = countMatchingFiles(dir, (p) => /\.test\.(ts|tsx|mjs)$/.test(p));
    const totalUnitTests = countMatchingFiles(
      dir,
      (p) => /\.test\.(ts|tsx|mjs)$/.test(p) && !/\.integration\.test\./.test(p),
    );
    const cold = callDad("plan", dir);
    const warm = callDad("plan", dir);

    const target = join(dir, "domains/notes/pure/note-rules.ts");
    const orig = readFileSync(target, "utf8");
    writeFileSync(target, `// comment\n${orig}`, "utf8");
    const commentPlan = callDad("plan", dir);

    const tweaked = orig.replace("value.replace", "String(value).replace");
    writeFileSync(
      target,
      tweaked !== orig ? tweaked : orig.replace("return ", "const _k = 1; void _k; return "),
      "utf8",
    );
    const logicPlan = callDad("plan", dir);
    const notesUnit = logicPlan.result.plan.tasks.find((t) => t.id === "domains-notes:unit");
    const runtimeTasks = logicPlan.result.plan.tasks.filter(
      (t) => t.decision === "run" && t.id !== "dads-fixture-kit-workbench:typecheck",
    );

    const narrowedStart = performance.now();
    const narrowedRun = spawnSync(VITEST_BIN, ["run", ...(notesUnit?.selectedFiles ?? [])], {
      cwd: dir,
      encoding: "utf8",
    });
    const narrowedVitestMs = Math.round(performance.now() - narrowedStart);

    const fullStart = performance.now();
    const fullRun = spawnSync(VITEST_BIN, ["run", "--exclude", "**/*.integration.test.*"], {
      cwd: dir,
      encoding: "utf8",
    });
    const fullVitestMs = Math.round(performance.now() - fullStart);
    writeFileSync(target, orig, "utf8");

    log(`  Files: ${totalTs} TS/MJS files, ${totalTests} total test files (${totalUnitTests} unit)`);
    log(
      `  Plan latency: cold=${cold.ms}ms, warm-reuse=${warm.ms}ms, comment-edit=${commentPlan.ms}ms, logic-edit=${logicPlan.ms}ms`,
    );
    log(`  Comment-only edit: ${commentPlan.result.plan.counts.run}/${commentPlan.result.plan.tasks.length} tasks run`);
    log(
      `  Leaf logic edit (note-rules.ts): ${runtimeTasks.length} runtime task(s), selectedFiles=${JSON.stringify(notesUnit?.selectedFiles ?? [])}, widened=${logicPlan.result.plan.tasks.filter((t) => t.widened && t.id !== "dads-fixture-kit-workbench:typecheck").length}`,
    );
    log(
      `  End-to-end wall clock: ${logicPlan.ms}ms + ${narrowedVitestMs}ms = ${logicPlan.ms + narrowedVitestMs}ms (exit=${narrowedRun.status}) vs full ${fullVitestMs}ms (exit=${fullRun.status})\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function benchDadsFramework() {
  log("=== 2. dads-framework monorepo (depth-2 packages, 2,000+ TS files) ===");
  const dir = mkdtempSync(join(tmpdir(), "dad-bench-mono-"));
  try {
    git(dir, ["clone", "--quiet", "--no-hardlinks", "--depth", "1", REPO_ROOT, "."]);
    symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
    writeFileSync(join(dir, ".git", "info", "exclude"), "node_modules\n", "utf8");

    const pkgRoots = [];
    for (const group of readdirSync(join(dir, "packages"), { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      for (const pkg of readdirSync(join(dir, "packages", group.name), { withFileTypes: true })) {
        const root = `packages/${group.name}/${pkg.name}`;
        if (existsSync(join(dir, root, "package.json"))) pkgRoots.push({ id: `${group.name}-${pkg.name}`, root });
      }
    }
    const manifest = {
      schemaVersion: 1,
      workspace: { root: ".", fullFallback: { taskIds: pkgRoots.map((p) => `${p.id}:test`) } },
      projects: pkgRoots.map((p) => ({ id: p.id, root: p.root, fallbackDependencies: [] })),
      tasks: pkgRoots.map((p) => ({
        id: `${p.id}:test`,
        project: p.id,
        kind: "test",
        execution: {
          executable: "node",
          args: ["-e", "process.exit(0)"],
          fileNarrowing: { suffixes: [".test.ts", ".test.tsx"] },
        },
        dependsOn: [],
        impact: { mode: "reachability", paths: [] },
      })),
    };
    writeFileSync(join(dir, "dads.testing.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    git(dir, ["add", "dads.testing.json"]);
    git(dir, ["-c", "user.name=Bench", "-c", "user.email=b@example.invalid", "commit", "-qm", "add manifest"]);

    const totalTs = countMatchingFiles(join(dir, "packages"), (p) => /\.tsx?$/.test(p));
    const totalTests = countMatchingFiles(join(dir, "packages"), (p) => /\.test\.tsx?$/.test(p));
    const cold = callDad("plan", dir);
    const warm = callDad("plan", dir);

    const target = join(dir, "packages/testing/core/src/plan-reasons.ts");
    const orig = readFileSync(target, "utf8");
    writeFileSync(target, `// comment benchmark\n${orig}`, "utf8");
    const commentPlan = callDad("plan", dir);

    const mutated = orig.replace("no changed path or symbol reaches this task", "no changed path reaches this task");
    assert.notEqual(mutated, orig, "Expected real semantic edit in plan-reasons.ts");
    writeFileSync(target, mutated, "utf8");
    const leafPlan = callDad("plan", dir);
    writeFileSync(target, orig, "utf8");

    const leafSelectedFiles = leafPlan.result.plan.tasks.flatMap((t) => t.selectedFiles ?? []);
    const leafWidened = leafPlan.result.plan.tasks.filter((t) => t.widened);
    const wideningCodes = {};
    for (const issue of leafPlan.result.plan.issues) {
      if (issue.severity === "uncertainty") wideningCodes[issue.code] = (wideningCodes[issue.code] ?? 0) + 1;
    }

    log(`  Packages: ${pkgRoots.length}, TS files: ${totalTs}, test files: ${totalTests}`);
    log(
      `  Plan latency: cold=${cold.ms}ms, warm-reuse=${warm.ms}ms, comment-edit=${commentPlan.ms}ms, leaf-edit=${leafPlan.ms}ms`,
    );
    log(
      `  Comment-only edit: ${commentPlan.result.plan.counts.run}/${pkgRoots.length} tasks run (fullFallback=${commentPlan.result.plan.scope.fullFallback})`,
    );
    log(
      `  Leaf edit (plan-reasons.ts): ${leafPlan.result.plan.counts.run}/${pkgRoots.length} tasks run (${Math.round(((pkgRoots.length - leafPlan.result.plan.counts.run) / pkgRoots.length) * 100)}% skipped), widened=${leafWidened.length}, narrowedFiles=${JSON.stringify(leafSelectedFiles)}`,
    );
    log(`  Uncertainty codes on leaf edit: ${JSON.stringify(wideningCodes)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function benchOssRepo(config) {
  log(`=== ${config.label} (shallow clone in /tmp) ===`);
  const dir = mkdtempSync(join(tmpdir(), `dad-bench-${config.id}-`));
  try {
    const clone = spawnSync("git", ["clone", "--quiet", "--depth", String(config.depth), config.url, dir], {
      encoding: "utf8",
    });
    if (clone.status !== 0) {
      log(`  SKIPPED: could not clone ${config.url} (${clone.stderr.trim()})\n`);
      return;
    }
    const srcRoot = config.resolveRoot(dir);
    const totalTs = countMatchingFiles(join(dir, srcRoot), (p) => /\.tsx?$/.test(p));
    const totalTests = countMatchingFiles(join(dir, srcRoot), (p) => /\.test\.tsx?$/.test(p));
    const manifest = {
      schemaVersion: 1,
      workspace: { root: ".", fullFallback: { taskIds: [`${config.id}:unit`] } },
      projects: [{ id: config.id, root: srcRoot, fallbackDependencies: [] }],
      tasks: [
        {
          id: `${config.id}:unit`,
          project: config.id,
          kind: "test",
          execution: {
            executable: "node",
            args: ["-e", "process.exit(0)"],
            fileNarrowing: { suffixes: [".test.ts", ".test.tsx"] },
          },
          dependsOn: [],
          impact: { mode: "reachability", paths: [] },
        },
      ],
    };
    writeFileSync(join(dir, "dads.testing.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    writeFileSync(join(dir, ".git", "info", "exclude"), "dads.testing.json\nnode_modules\n", "utf8");
    if (config.linkNodeModules) symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));

    const cold = callDad("plan", dir);
    const warm = callDad("plan", dir);
    log(`  ${config.id} ${srcRoot}: ${totalTs} TS files, ${totalTests} test files`);
    log(`  Plan latency: cold=${cold.ms}ms, warm-reuse=${warm.ms}ms`);

    const samplePath = config.pickSample(dir, srcRoot);
    if (samplePath) {
      const orig = readFileSync(samplePath, "utf8");
      writeFileSync(samplePath, `// oss comment bench\n${orig}`, "utf8");
      const commentPlan = callDad("plan", dir);
      log(
        `  Comment-only edit (${samplePath.slice(dir.length + 1)}): ${commentPlan.result.plan.counts.run}/1 task run (${commentPlan.ms}ms)`,
      );
      writeFileSync(samplePath, orig, "utf8");
    }

    for (const mut of config.mutations ?? []) {
      const fullPath = join(dir, mut.file);
      if (!existsSync(fullPath)) continue;
      const orig = readFileSync(fullPath, "utf8");
      const mutated = mut.mutate(orig);
      if (mutated === orig) continue;
      writeFileSync(fullPath, mutated, "utf8");
      try {
        const planRes = callDad("plan", dir);
        const task = planRes.result.plan.tasks[0];
        const selected = task.selectedFiles ?? [];
        const issues = planRes.result.plan.issues
          .filter((i) => i.severity === "uncertainty")
          .slice(0, 3)
          .map((i) => `${i.code}@${i.path ?? ""}`);
        log(
          `  Mutation ${mut.name}: plan=${planRes.ms}ms, widened=${task.widened}, selected=${selected.length}/${totalTests}${issues.length ? ` issues=${JSON.stringify(issues)}` : ""}`,
        );
      } finally {
        writeFileSync(fullPath, orig, "utf8");
      }
    }
    log("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await benchKitWorkbench();
benchDadsFramework();
benchOssRepo({
  id: "hono",
  label: "3. Large OSS TypeScript Repo: honojs/hono",
  url: "https://github.com/honojs/hono.git",
  depth: 15,
  linkNodeModules: true,
  resolveRoot: () => "src",
  pickSample: (dir) => join(dir, "src/utils/url.ts"),
  mutations: [{ name: "src/utils/html.ts", file: "src/utils/html.ts", mutate: (s) => s.replace("&amp;", "&BROKEN;") }],
});
benchOssRepo({
  id: "zod",
  label: "4. Large OSS TypeScript Repo: colinhacks/zod",
  url: "https://github.com/colinhacks/zod.git",
  depth: 10,
  linkNodeModules: false,
  resolveRoot: (dir) => (existsSync(join(dir, "packages/zod/src")) ? "packages/zod/src" : "src"),
  pickSample: (dir, root) => {
    const stack = [join(dir, root)];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const e of readdirSync(cur, { withFileTypes: true })) {
        const full = join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) return full;
      }
    }
    return undefined;
  },
});
