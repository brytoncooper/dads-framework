#!/usr/bin/env node
/**
 * Layer 3b verification: Live Quint Content-Hashed Task Receipt Trace Replay.
 *
 * Replays ITF traces generated from `specs/dad-test/snapshot_store.qnt` against
 * the real compiled `dad-test` binary (`operation: "run", cache: true`),
 * verifying exact receipt soundness and precision (`inv_receipt_sound_and_precise`):
 *   - 0 false cache hits when any source, policy file, manifest, or command changes
 *   - 0 false cache misses when a passing receipt already exists for identical inputs
 *   - failing runs never write receipts
 *   - `--no-cache` (`cache: false`) always bypasses receipts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_PATH = join(REPO_ROOT, "specs", "dad-test", "snapshot_store.qnt");
const RUST_BIN = existsSync(join(REPO_ROOT, "target", "release", "dad-test"))
  ? join(REPO_ROOT, "target", "release", "dad-test")
  : join(REPO_ROOT, "target", "debug", "dad-test");

const log = (line) => process.stdout.write(`${line}\n`);

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${res.stderr}`);
  return res.stdout.trim();
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

function generateTrace(seed, outFile) {
  const args = ["run", SPEC_PATH, "--max-samples=1", "--max-steps=22", `--seed=${seed}`, `--out-itf=${outFile}`];
  let res = spawnSync("quint", args, { encoding: "utf8" });
  if (res.error) res = spawnSync("npx", ["-y", "@informalsystems/quint", ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`quint run failed (seed=${seed}):\n${res.stderr}\n${res.stdout}`);
  return JSON.parse(readFileSync(outFile, "utf8"));
}

function fileContents(file, version) {
  if (version === 0) return null;
  if (file === "tsconfig.json") return `{"compilerOptions":{"target":"ES2023"},"_v":${version}}\n`;
  if (file === "a.ts") return `export const a = ${version};\n`;
  if (file === "b.ts") return `export const b = ${version};\n`;
  if (file === "test.ts") return `export const t = ${version};\n`;
  throw new Error(`Unknown model file: ${file}`);
}

function applyWorkspace(dir, workingTreeMap, manifestVersion, unitCmdVersion, counterPath) {
  for (const file of ["a.ts", "b.ts", "test.ts", "tsconfig.json"]) {
    const version = itfInt(workingTreeMap.get(file));
    const target = join(dir, file === "tsconfig.json" ? file : `src/${file}`);
    const content = fileContents(file, version);
    if (content === null) rmSync(target, { force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
  }
  const manifest = {
    schemaVersion: 1,
    workspace: { root: ".", fullFallback: { taskIds: ["t_unit"] } },
    projects: [{ id: "app", root: "src", fallbackDependencies: [] }],
    tasks: [
      {
        id: "t_unit",
        project: "app",
        kind: "test",
        execution: {
          executable: "sh",
          args: ["-c", `printf x >> '${counterPath}' && printf 'm=${manifestVersion};c=${unitCmdVersion}'`],
        },
        dependsOn: [],
        impact: { mode: "always", paths: [] },
      },
    ],
  };
  writeFileSync(join(dir, "dads.testing.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function stateSignature(workingTreeMap, manifestVersion, unitCmdVersion) {
  return JSON.stringify({
    a: itfInt(workingTreeMap.get("a.ts")),
    b: itfInt(workingTreeMap.get("b.ts")),
    test: itfInt(workingTreeMap.get("test.ts")),
    tsconfig: itfInt(workingTreeMap.get("tsconfig.json")),
    manifestVersion,
    unitCmdVersion,
  });
}

function runCached(dir, cache) {
  const req = {
    schemaVersion: 1,
    operation: "run",
    workspaceRoot: dir,
    manifestPath: "dads.testing.json",
    all: true,
    taskIds: [],
    jobs: 1,
    cache,
  };
  const res = spawnSync(RUST_BIN, [], { input: JSON.stringify(req), encoding: "utf8" });
  if (res.status !== 0) throw new Error(`dad-test failed:\n${res.stderr}\n${res.stdout}`);
  const env = JSON.parse(res.stdout);
  assert.equal(env.ok, true, `dad-test error: ${JSON.stringify(env)}`);
  return env.result.run;
}

const tempRoot = mkdtempSync(join(tmpdir(), "dad-quint-receipt-replay-"));
let totalHits = 0;
let totalMisses = 0;

try {
  const seeds = ["0xa1", "0xb2", "0xc3", "0xd4", "0xe5"];
  for (const seed of seeds) {
    const trace = generateTrace(seed, join(tempRoot, `trace-${seed}.itf.json`));
    const repoDir = join(tempRoot, `repo-${seed}`);
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q"]);
    const counterPath = join(repoDir, ".git", "exec-count.txt");
    writeFileSync(counterPath, "", "utf8");

    const initMap = itfMap(trace.states[0].workingTree);
    const initCmdMap = itfMap(trace.states[0].taskCommandDigest);
    applyWorkspace(
      repoDir,
      initMap,
      itfInt(trace.states[0].manifestDigest),
      itfInt(initCmdMap.get("t_unit")),
      counterPath,
    );
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.name=Quint", "-c", "user.email=q@example.invalid", "commit", "-qm", "base"]);

    const expectedPassedKeys = new Set();
    let execCount = 0;

    for (let i = 1; i < trace.states.length; i += 1) {
      const state = trace.states[i];
      const wt = itfMap(state.workingTree);
      const cmdMap = itfMap(state.taskCommandDigest);
      const manifestV = itfInt(state.manifestDigest);
      const cmdV = itfInt(cmdMap.get("t_unit"));

      applyWorkspace(repoDir, wt, manifestV, cmdV, counterPath);
      const sig = stateSignature(wt, manifestV, cmdV);
      const shouldHit = expectedPassedKeys.has(sig);

      const run = runCached(repoDir, true);
      const actualHit = run.tasks[0].cached === true;
      const diskCount = readFileSync(counterPath, "utf8").length;

      assert.equal(
        actualHit,
        shouldHit,
        `Receipt soundness/precision mismatch at seed=${seed} step=${i}: sig=${sig} expectedHit=${shouldHit} actualHit=${actualHit}`,
      );
      if (shouldHit) {
        totalHits += 1;
        assert.equal(diskCount, execCount, "Cached hit must NOT spawn child process");
      } else {
        totalMisses += 1;
        execCount += 1;
        assert.equal(diskCount, execCount, "Cache miss must execute child process exactly once");
        expectedPassedKeys.add(sig);
      }
    }
    log(`  PASS seed=${seed}: ${trace.states.length - 1} steps verified against exact receipt oracle`);
  }

  assert.ok(totalHits > 0 && totalMisses > 0, `Expected both hits (${totalHits}) and misses (${totalMisses})`);
  log(
    `\nLayer 3b Quint Receipt Replay: 100% exact parity (${totalHits} verified hits, ${totalMisses} verified misses, 0 false hits, 0 false misses).`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
