#!/usr/bin/env node
/**
 * Layer 3c verification: Live Quint Remote L2 Receipt & Env Isolation Trace Replay.
 *
 * Replays ITF traces generated from `specs/dad-test/remote_receipts_and_env.qnt`
 * against the real compiled `dad-test` binary across TWO isolated worker Git repos
 * (`pr_ci` and `merge_queue`) sharing a live local HTTP/1.1 L2 remote cache server:
 *   - Verifies exact L1 hits, L2 cross-worker hits (with L1 hydration), and misses
 *   - Verifies `execution.env` changes (`VITEST_TIER=unit` vs `integration`) never cross-hit
 *   - Verifies `DADS_TESTING_RUNTIME_FINGERPRINT` changes never cross-hit
 *   - Verifies SQL/TS/tsconfig file changes always invalidate
 *   - Verifies corrupt L2 blobs fail closed and re-execute
 *   - Verifies network outage fails closed without breaking execution
 *   - Verifies failing tasks NEVER write L1 or upload to L2
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_PATH = join(REPO_ROOT, "specs", "dad-test", "remote_receipts_and_env.qnt");
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
  const args = ["run", SPEC_PATH, "--max-samples=1", "--max-steps=24", `--seed=${seed}`, `--out-itf=${outFile}`];
  let res = spawnSync("quint", args, { encoding: "utf8" });
  if (res.error) res = spawnSync("npx", ["-y", "@informalsystems/quint", ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`quint run failed (seed=${seed}):\n${res.stderr}\n${res.stdout}`);
  return JSON.parse(readFileSync(outFile, "utf8"));
}

function applyWorkerState(dir, fileMap, envMap, failingTask) {
  writeFileSync(join(dir, "src", "src.ts"), `export const v = ${itfInt(fileMap.get("src.ts"))};\n`, "utf8");
  writeFileSync(
    join(dir, "src", "migration.sql"),
    `-- v${itfInt(fileMap.get("migration.sql"))}\nCREATE TABLE t (id INT);\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    `{"compilerOptions":{"target":"ES2023"},"_v":${itfInt(fileMap.get("tsconfig.json"))}}\n`,
    "utf8",
  );

  // Relative counter paths stay identical across workers so L2 keys match across `pr_ci` and `merge_queue`.
  const tasks = ["domain:unit", "domain:integration"].map((taskId) => {
    const tier = itfInt(envMap.get(taskId)) === 1 ? "unit" : "integration";
    const counterRel = `.git/exec-${taskId.replace(":", "-")}.txt`;
    const cmd =
      failingTask === taskId
        ? `printf x >> '${counterRel}' && exit 1`
        : `printf x >> '${counterRel}' && printf '%s:%s' '${taskId}' "$VITEST_TIER"`;
    return {
      id: taskId,
      project: "app",
      kind: "test",
      execution: {
        executable: "sh",
        args: ["-c", cmd],
        env: { VITEST_TIER: tier },
      },
      dependsOn: [],
      impact: { mode: "always", paths: [] },
    };
  });

  const manifest = {
    schemaVersion: 1,
    workspace: { root: ".", fullFallback: { taskIds: ["domain:unit", "domain:integration"] } },
    projects: [{ id: "app", root: "src", fallbackDependencies: [] }],
    tasks,
  };
  writeFileSync(join(dir, "dads.testing.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function runDadTestAsync(dir, runtimeFp, remoteCacheUrl) {
  return new Promise((resolve, reject) => {
    const req = {
      schemaVersion: 1,
      operation: "run",
      workspaceRoot: dir,
      manifestPath: "dads.testing.json",
      all: true,
      taskIds: [],
      jobs: 1,
      cache: true,
      ...(remoteCacheUrl ? { remoteCacheUrl } : {}),
    };
    const child = spawn(RUST_BIN, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DADS_TESTING_RUNTIME_FINGERPRINT: `rt-${runtimeFp}` },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`dad-test exited ${code}:\n${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      const env = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      assert.equal(env.ok, true, `dad-test error: ${JSON.stringify(env)}`);
      resolve(env.result.run);
    });
    child.stdin.end(JSON.stringify(req));
  });
}

async function startMockL2Server() {
  const blobs = new Map();
  let online = true;

  const server = http.createServer((req, res) => {
    if (!online) {
      res.writeHead(503);
      res.end("offline");
      return;
    }
    const key = req.url ?? "";
    if (req.method === "GET") {
      const payload = blobs.get(key);
      if (payload === undefined) {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": payload.length });
        res.end(payload);
      }
      return;
    }
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        blobs.set(key, Buffer.concat(chunks));
        res.writeHead(200, { "Content-Length": 0 });
        res.end();
      });
      return;
    }
    res.writeHead(405);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/l2`,
    blobs,
    setOnline: (v) => {
      online = v;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function workerKey(fileMap, envMap, runtimeFp, failingTask, taskId) {
  // Manifest bytes include both tasks' env + failingTask command, so key depends on the full workspace + manifest state.
  return JSON.stringify({
    taskId,
    rt: runtimeFp,
    unitEnv: itfInt(envMap.get("domain:unit")),
    intEnv: itfInt(envMap.get("domain:integration")),
    failingTask,
    src: itfInt(fileMap.get("src.ts")),
    sql: itfInt(fileMap.get("migration.sql")),
    ts: itfInt(fileMap.get("tsconfig.json")),
  });
}

const tempRoot = mkdtempSync(join(tmpdir(), "dad-quint-remote-replay-"));
let totalL1Hits = 0;
let totalL2Hits = 0;
let totalMisses = 0;
let totalCorruptRecoveries = 0;

try {
  const seeds = ["0x11", "0x22", "0x33", "0x44"];
  for (const seed of seeds) {
    const trace = generateTrace(seed, join(tempRoot, `trace-${seed}.itf.json`));
    const l2 = await startMockL2Server();

    const workers = new Map();
    const l1Known = new Map();
    const l2Known = new Map(); // sig -> { corrupt: bool }

    for (const w of ["pr_ci", "merge_queue"]) {
      const dir = join(tempRoot, `repo-${seed}-${w}`);
      mkdirSync(join(dir, "src"), { recursive: true });
      git(dir, ["init", "-q"]);
      writeFileSync(join(dir, ".git", "exec-domain-unit.txt"), "", "utf8");
      writeFileSync(join(dir, ".git", "exec-domain-integration.txt"), "", "utf8");
      const initFiles = itfMap(itfMap(trace.states[0].workerFiles).get(w));
      const initEnvs = itfMap(itfMap(trace.states[0].workerEnv).get(w));
      applyWorkerState(dir, initFiles, initEnvs, null);
      git(dir, ["add", "-A"]);
      git(dir, ["-c", "user.name=Quint", "-c", "user.email=q@example.invalid", "commit", "-qm", "base"]);
      workers.set(w, {
        dir,
        execs: new Map([
          ["domain:unit", 0],
          ["domain:integration", 0],
        ]),
      });
      l1Known.set(w, new Set());
    }

    try {
      for (let i = 1; i < trace.states.length; i += 1) {
        const state = trace.states[i];
        const action = state.lastAction;
        l2.setOnline(state.remoteAvailable === true);

        if (action === "corrupt_l2" && l2.blobs.size > 0) {
          for (const key of l2.blobs.keys()) {
            l2.blobs.set(key, Buffer.from("{corrupt-l2", "utf8"));
          }
          for (const sig of l2Known.keys()) {
            l2Known.set(sig, { corrupt: true });
          }
          continue;
        }

        const wfMap = itfMap(state.workerFiles);
        const weMap = itfMap(state.workerEnv);
        const wrMap = itfMap(state.workerRuntime);

        const w = i % 2 === 0 ? "pr_ci" : "merge_queue";
        const worker = workers.get(w);
        const fileMap = itfMap(wfMap.get(w));
        const envMap = itfMap(weMap.get(w));
        const rt = itfInt(wrMap.get(w));
        const online = state.remoteAvailable === true;
        const failingTask = action === "miss_fail" ? "domain:unit" : null;

        applyWorkerState(worker.dir, fileMap, envMap, failingTask);

        const run = await runDadTestAsync(worker.dir, rt, l2.url);

        for (const taskId of ["domain:unit", "domain:integration"]) {
          const sig = workerKey(fileMap, envMap, rt, failingTask, taskId);
          const hasL1 = l1Known.get(w).has(sig);
          const l2Entry = l2Known.get(sig);
          const hasValidL2 = !hasL1 && online && l2Entry !== undefined && !l2Entry.corrupt;
          const wasCorruptL2 = !hasL1 && online && l2Entry !== undefined && l2Entry.corrupt;
          const taskResult = run.tasks.find((t) => t.id === taskId);
          const actualCached = taskResult.cached === true;
          const expectedCached = hasL1 || hasValidL2;

          assert.equal(
            actualCached,
            expectedCached,
            `Mismatch at seed=${seed} step=${i} worker=${w} task=${taskId} online=${online} hasL1=${hasL1} hasValidL2=${hasValidL2}: expectedCached=${expectedCached} actualCached=${actualCached}`,
          );

          const counterPath = join(worker.dir, ".git", `exec-${taskId.replace(":", "-")}.txt`);
          const diskExecs = readFileSync(counterPath, "utf8").length;
          if (expectedCached) {
            assert.equal(diskExecs, worker.execs.get(taskId), "Cache hit must not spawn child process");
            assert.equal(taskResult.exitCode, 0);
            if (hasL1) {
              totalL1Hits += 1;
            } else {
              totalL2Hits += 1;
              l1Known.get(w).add(sig);
            }
          } else {
            totalMisses += 1;
            worker.execs.set(taskId, worker.execs.get(taskId) + 1);
            assert.equal(diskExecs, worker.execs.get(taskId), "Cache miss must spawn child process once");
            if (wasCorruptL2) totalCorruptRecoveries += 1;
            if (failingTask !== taskId) {
              assert.equal(taskResult.exitCode, 0);
              l1Known.get(w).add(sig);
              if (online) {
                l2Known.set(sig, { corrupt: false });
              }
            } else {
              assert.equal(taskResult.exitCode, 1);
            }
          }
        }
      }
      log(`  PASS seed=${seed}: ${trace.states.length - 1} steps replayed across pr_ci + merge_queue + HTTP L2`);
    } finally {
      await l2.close();
    }
  }

  assert.ok(
    totalL1Hits > 0 && totalL2Hits > 0 && totalMisses > 0,
    `Expected L1 (${totalL1Hits}), L2 (${totalL2Hits}), and misses (${totalMisses})`,
  );
  log(
    `\nLayer 3c Quint Remote L2 + Env Replay: 100% exact parity (${totalL1Hits} L1 hits, ${totalL2Hits} cross-worker L2 hits, ${totalMisses} misses, ${totalCorruptRecoveries} corrupt-L2 fail-closed recoveries, 0 false hits).`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
