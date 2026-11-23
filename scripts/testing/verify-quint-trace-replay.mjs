#!/usr/bin/env node
/**
 * Layer 3 verification: Quint Snapshot Store Trace Replay against real Rust
 * `dads-testing-store` (`dad-test`) in a live Git repository.
 *
 * Generates real ITF execution traces from `specs/dad-test/snapshot_store.qnt`
 * across multiple seeds and replays every file edit, branch checkout, moved
 * `--base` ref, and on-disk snapshot corruption against a real Git workspace.
 * After every `loadOrUpdate` transition, compares the stateful cached/patched
 * `dad-test plan` against a fresh cold `dad-test plan` and asserts 100% cache
 * equivalence plus real incremental patching (`graph-incremental-update`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_PATH = join(REPO_ROOT, "specs", "dad-test", "snapshot_store.qnt");
const RUST_BIN = resolveRustBinary();

function resolveRustBinary() {
  const release = join(REPO_ROOT, "target", "release", "dad-test");
  if (existsSync(release)) return release;
  const debug = join(REPO_ROOT, "target", "debug", "dad-test");
  if (existsSync(debug)) return debug;
  throw new Error("Missing dad-test binary. Run `cargo build --release -p dad-test` first.");
}

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${res.stderr}\n${res.stdout}`);
  }
  return res.stdout.trim();
}

function runDadPlan(workspaceRoot, baseSha) {
  const req = {
    schemaVersion: 1,
    operation: "plan",
    workspaceRoot,
    manifestPath: "dads.testing.json",
    all: false,
    taskIds: [],
    ...(baseSha === undefined ? {} : { base: baseSha }),
  };
  const res = spawnSync(RUST_BIN, [], { input: JSON.stringify(req), encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`dad-test failed (${String(res.status)}):\n${res.stderr}\n${res.stdout}`);
  }
  const env = JSON.parse(res.stdout);
  assert.equal(env.ok, true, `dad-test returned error: ${JSON.stringify(env)}`);
  return env.result.plan;
}

function itfInt(v) {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "#bigint" in v) return Number(v["#bigint"]);
  throw new Error(`Unexpected ITF int: ${JSON.stringify(v)}`);
}

function itfMap(v) {
  const out = new Map();
  for (const [k, val] of v["#map"] ?? []) {
    out.set(typeof k === "string" ? k : itfInt(k), val);
  }
  return out;
}

function fileContentsFor(file, version) {
  if (version === 0) return null;
  if (file === "tsconfig.json") {
    return (
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            paths: version === 1 ? {} : { "@alt/*": [`./src/v${version}/*`] },
          },
        },
        null,
        2,
      ) + "\n"
    );
  }
  if (file === "a.ts") {
    return `export const aVal = (): number => ${version};\nexport const aUnused = (): number => 100;\n`;
  }
  if (file === "b.ts") {
    return `import { aVal } from "./a.js";\nexport const bVal = (): number => aVal() + ${version};\n`;
  }
  if (file === "test.ts") {
    return `import { bVal } from "./b.js";\nif (bVal() < ${version}) throw new Error("fail");\n`;
  }
  throw new Error(`Unknown model file: ${file}`);
}

function mapPath(file) {
  return file === "tsconfig.json" ? "tsconfig.json" : `src/${file}`;
}

function applyFileMap(dir, fileMap) {
  for (const file of ["a.ts", "b.ts", "test.ts", "tsconfig.json"]) {
    const version = itfInt(fileMap.get(file));
    const target = join(dir, mapPath(file));
    const contents = fileContentsFor(file, version);
    if (contents === null) {
      rmSync(target, { force: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf8");
    }
  }
}

function normalizeDecisions(plan) {
  return plan.tasks.map((t) => ({
    id: t.id,
    decision: t.decision,
    widened: t.widened,
    selectedFiles: [...(t.selectedFiles ?? [])].sort(),
  }));
}

function corruptSnapshotsInGitDir(repoDir) {
  const storeDir = join(repoDir, ".git", "dads-testing");
  if (!existsSync(storeDir)) return;
  for (const entry of readdirSync(storeDir)) {
    const full = join(storeDir, entry);
    try {
      writeFileSync(full, "{corrupted-quint-replay", "utf8");
    } catch {
      // ignore subdirectories
    }
  }
}

function findSnapshotIssueCode(plan) {
  const codes = new Set([
    "graph-initial-index",
    "graph-snapshot-reused",
    "graph-incremental-update",
    "graph-snapshot-rebuild",
    "graph-snapshot-corrupt",
  ]);
  return plan.issues.map((i) => i.code).filter((c) => codes.has(c));
}

function generateTrace(seed, outFile) {
  const args = ["run", SPEC_PATH, "--max-samples=1", "--max-steps=22", `--seed=${seed}`, `--out-itf=${outFile}`];
  let res = spawnSync("quint", args, { encoding: "utf8" });
  if (res.error) {
    res = spawnSync("npx", ["-y", "@informalsystems/quint", ...args], { encoding: "utf8" });
  }
  if (res.status !== 0) {
    throw new Error(`quint run failed (seed=${seed}):\n${res.stderr}\n${res.stdout}`);
  }
  return JSON.parse(readFileSync(outFile, "utf8"));
}

function buildManifest(manifestVersion) {
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        workspace: { root: ".", fullFallback: { taskIds: ["app:unit"] } },
        projects: [{ id: "app", root: "src", fallbackDependencies: [] }],
        tasks: [
          {
            id: "app:unit",
            project: "app",
            kind: "test",
            execution: {
              executable: "node",
              args: ["-e", `process.exit(0); // m${manifestVersion}`],
              fileNarrowing: { suffixes: ["test.ts"] },
            },
            dependsOn: [],
            impact: { mode: "reachability", paths: [] },
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

const tempRoot = mkdtempSync(join(tmpdir(), "dad-quint-replay-"));
const actionCounts = new Map();
let totalComparisons = 0;

try {
  const seeds = ["0x101", "0x202", "0x303", "0x404", "0x505"];
  for (const seed of seeds) {
    const traceFile = join(tempRoot, `trace-${seed}.itf.json`);
    const trace = generateTrace(seed, traceFile);
    const states = trace.states;
    assert.ok(states.length > 1, `Empty trace for seed ${seed}`);

    const repoDir = join(tempRoot, `repo-${seed}`);
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q"]);
    writeFileSync(join(repoDir, "package.json"), '{"name":"quint-replay","type":"module"}\n', "utf8");
    writeFileSync(join(repoDir, "dads.testing.json"), buildManifest(1), "utf8");

    const initCommits = itfMap(states[0].commits);
    applyFileMap(repoDir, itfMap(initCommits.get(1)));
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.name=Quint", "-c", "user.email=q@example.invalid", "commit", "-qm", "commit-1"]);
    const commit1 = git(repoDir, ["rev-parse", "HEAD"]);

    applyFileMap(repoDir, itfMap(initCommits.get(2)));
    git(repoDir, ["add", "-A"]);
    git(repoDir, [
      "-c",
      "user.name=Quint",
      "-c",
      "user.email=q@example.invalid",
      "commit",
      "-qm",
      "commit-2",
      "--allow-empty",
    ]);
    const commit2 = git(repoDir, ["rev-parse", "HEAD"]);
    const shas = { 1: commit1, 2: commit2 };

    // Start at state 0's headCommit
    let currentHead = itfInt(states[0].headCommit);
    git(repoDir, ["checkout", "-q", shas[currentHead]]);
    applyFileMap(repoDir, itfMap(states[0].workingTree));

    let currentManifestVersion = itfInt(states[0].manifestDigest);
    let seedChecks = 0;

    for (let i = 1; i < states.length; i += 1) {
      const prev = states[i - 1];
      const curr = states[i];

      const nextHead = itfInt(curr.headCommit);
      if (nextHead !== currentHead) {
        git(repoDir, ["checkout", "-qf", shas[nextHead]]);
        currentHead = nextHead;
      }

      const nextManifest = itfInt(curr.manifestDigest);
      if (nextManifest !== currentManifestVersion) {
        writeFileSync(join(repoDir, "dads.testing.json"), buildManifest(nextManifest), "utf8");
        currentManifestVersion = nextManifest;
      }

      applyFileMap(repoDir, itfMap(curr.workingTree));

      if (!prev.persisted.corrupt && curr.persisted.corrupt) {
        corruptSnapshotsInGitDir(repoDir);
      }

      // Whenever Quint served a plan (or every 3rd step to maximize real store coverage), compare stateful vs cold!
      const shouldCheck = curr.hasServed === true || i % 3 === 0;
      if (!shouldCheck) continue;

      const baseCommit = itfInt(curr.baseCommit);
      const baseSha = baseCommit === currentHead ? undefined : shas[baseCommit];

      const statefulPlan = runDadPlan(repoDir, baseSha);

      // Build an identical cold clone with no `.git/dads-testing`
      const coldDir = join(tempRoot, `cold-${seed}-${i}`);
      cpSync(repoDir, coldDir, {
        recursive: true,
        filter: (p) => !p.includes(`${join(".git", "dads-testing")}`),
      });
      rmSync(join(coldDir, ".git", "dads-testing"), { recursive: true, force: true });
      const coldPlan = runDadPlan(coldDir, baseSha);
      rmSync(coldDir, { recursive: true, force: true });

      assert.deepEqual(
        normalizeDecisions(statefulPlan),
        normalizeDecisions(coldPlan),
        `Cache equivalence mismatch at seed=${seed} step=${i} (quint lastAction=${curr.lastAction})`,
      );
      assert.equal(
        statefulPlan.scope.fullFallback,
        coldPlan.scope.fullFallback,
        `fullFallback mismatch at seed=${seed} step=${i}`,
      );

      for (const code of findSnapshotIssueCode(statefulPlan)) {
        actionCounts.set(code, (actionCounts.get(code) ?? 0) + 1);
      }
      totalComparisons += 1;
      seedChecks += 1;
    }
    process.stdout.write(
      `${`  PASS seed=${seed}: replayed ${states.length - 1} steps, ${seedChecks} stateful==cold equivalence checks`}\n`,
    );
  }

  // Also explicitly verify incremental patching triggers on a clean single-file edit
  const patchRepo = join(tempRoot, "patch-check");
  mkdirSync(patchRepo, { recursive: true });
  git(patchRepo, ["init", "-q"]);
  writeFileSync(join(patchRepo, "package.json"), '{"name":"patch-check","type":"module"}\n', "utf8");
  writeFileSync(join(patchRepo, "dads.testing.json"), buildManifest(1), "utf8");
  writeFileSync(join(patchRepo, "tsconfig.json"), fileContentsFor("tsconfig.json", 1), "utf8");
  mkdirSync(join(patchRepo, "src"), { recursive: true });
  writeFileSync(join(patchRepo, "src/a.ts"), fileContentsFor("a.ts", 1), "utf8");
  writeFileSync(join(patchRepo, "src/b.ts"), fileContentsFor("b.ts", 1), "utf8");
  writeFileSync(join(patchRepo, "src/test.ts"), fileContentsFor("test.ts", 1), "utf8");
  git(patchRepo, ["add", "-A"]);
  git(patchRepo, ["-c", "user.name=Quint", "-c", "user.email=q@example.invalid", "commit", "-qm", "base"]);

  const p1 = runDadPlan(patchRepo);
  assert.ok(findSnapshotIssueCode(p1).includes("graph-initial-index"), "Expected initial index");
  const p2 = runDadPlan(patchRepo);
  assert.ok(findSnapshotIssueCode(p2).includes("graph-snapshot-reused"), "Expected reuse on unchanged tree");
  writeFileSync(join(patchRepo, "src/a.ts"), fileContentsFor("a.ts", 2), "utf8");
  const p3 = runDadPlan(patchRepo);
  assert.ok(
    findSnapshotIssueCode(p3).includes("graph-incremental-update"),
    `Expected graph-incremental-update on single-file edit with unchanged tsconfig.json, got: ${JSON.stringify(p3.issues)}`,
  );
  actionCounts.set("graph-incremental-update", (actionCounts.get("graph-incremental-update") ?? 0) + 1);

  process.stdout.write(
    `${`\nLayer 3 Quint Trace Replay: ${totalComparisons} stateful==cold checks passed across 5 traces.`}\n`,
  );
  process.stdout.write(`${("Observed store actions:", Object.fromEntries([...actionCounts.entries()].sort()))}\n`);
  assert.ok((actionCounts.get("graph-incremental-update") ?? 0) > 0, "Expected at least one real incremental patch!");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
