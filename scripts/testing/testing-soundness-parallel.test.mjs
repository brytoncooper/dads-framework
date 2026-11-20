import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  createFixture,
  events,
  runFixture,
} from "./testing-soundness-test-fixture.mjs";

const runner = resolve(
  process.env.DADS_SOUNDNESS_TEST_RUNNER ??
    "scripts/testing/testing-soundness.mjs",
);

test("CLI auto mode overlaps isolated cases when sampled resources allow it", () => {
  const fixture = createFixture();
  try {
    const probe = resourceProbe(fixture, 1);
    const taskPath = join(fixture.baseline, "task.cjs");
    const task = readFileSync(taskPath, "utf8");
    const exit = "process.exit(mode === 'baseline'";
    assert.ok(task.includes(exit));
    const barrier = `
if (mode !== 'baseline') {
  const peer = mode === 'alpha' ? 'beta' : 'alpha';
  const directory = ${JSON.stringify(fixture.root)};
  fs.writeFileSync(directory + '/' + mode + '.started', 'started');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(directory + '/' + peer + '.started')) {
    if (Date.now() > deadline) process.exit(97);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
`;
    writeFileSync(taskPath, task.replace(exit, barrier + exit));
    const { result, evidence } = runFixture(fixture, false, {
      nodeArguments: ["--import", probe],
      env: { DADS_TEST_ASSERT_LIMITS: "1", VITEST_MAX_WORKERS: "99" },
    });
    assert.equal(
      result.status,
      0,
      JSON.stringify({ stderr: result.stderr, evidence }),
    );
    assert.equal(evidence.summary.status, "pass");
    assert.equal(evidence.concurrency.caseJobs, 2);
    assert.equal(evidence.concurrency.mode, "auto");
    assert.equal(evidence.concurrency.peakCases, 2);
    assert.deepEqual(
      evidence.cases.map((item) => item.id),
      ["alpha", "beta"],
    );
    const observed = events(fixture);
    assert.equal(observed[0], "baseline");
    assert.deepEqual(observed.slice(1, 3).sort(), ["alpha", "beta"]);
    assert.deepEqual(observed.slice(3).sort(), ["native:alpha", "native:beta"]);
    assert.deepEqual(evidence.executionCounts, {
      baselineTasks: 1,
      mutantTasks: 2,
      nativeTasks: 2,
      nativeInvocations: 2,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI auto mode stays sequential on a busy host", () => {
  const fixture = createFixture();
  try {
    const { result, evidence } = runFixture(fixture, false, {
      nodeArguments: ["--import", resourceProbe(fixture, 0)],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(evidence.concurrency.caseJobs, 1);
    assert.deepEqual(events(fixture), [
      "baseline",
      "alpha",
      "native:alpha",
      "beta",
      "native:beta",
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI baseline failure starts no cases even when auto concurrency is available", () => {
  const fixture = createFixture();
  try {
    const { result, evidence } = runFixture(fixture, true, {
      nodeArguments: ["--import", resourceProbe(fixture, 1)],
    });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(events(fixture), ["baseline"]);
    assert.equal(evidence.cases.length, 0);
    assert.equal(evidence.executionCounts.nativeInvocations, 0);
    assert.equal(evidence.executionCounts.mutantTasks, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI retains every case result when one concurrent case fails validation", () => {
  const fixture = createFixture();
  try {
    const corpusPath = join(fixture.root, "cases.json");
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
    corpus.cases[0].classification = "control";
    corpus.cases[0].expectedChangedTaskIds = [];
    writeFileSync(corpusPath, JSON.stringify(corpus));
    const { result, evidence } = runFixture(fixture, false, { caseJobs: "2" });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(evidence.summary.status, "fail");
    assert.deepEqual(
      evidence.cases.map((item) => item.id),
      ["alpha", "beta"],
    );
    assert.match(evidence.cases[0].executionError, /observed fixture:test/);
    assert.deepEqual(evidence.cases[1].selectedTaskIds, ["fixture:test"]);
    assert.equal(evidence.executionCounts.mutantTasks, 2);
    assert.equal(evidence.executionCounts.nativeInvocations, 1);
    assert.equal(evidence.summary.executionFailures, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("shards run disjoint slices of the sorted corpus and record what they ran", () => {
  const fixtures = [createFixture(), createFixture()];
  try {
    const first = runShard(fixtures[0], "1/2", "first.json");
    const second = runShard(fixtures[1], "2/2", "second.json");
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.deepEqual(first.evidence.shard, {
      index: 1,
      count: 2,
      caseIds: ["alpha"],
    });
    assert.deepEqual(second.evidence.shard, {
      index: 2,
      count: 2,
      caseIds: ["beta"],
    });
    assert.deepEqual(first.evidence.corpus.caseIds, ["alpha", "beta"]);
    assert.equal(first.evidence.summary.cases, 1);
    assert.equal(first.evidence.summary.status, "pass");
    assert.deepEqual(events(fixtures[0]), [
      "baseline",
      "alpha",
      "native:alpha",
    ]);
    assert.deepEqual(events(fixtures[1]), ["baseline", "beta", "native:beta"]);
  } finally {
    for (const fixture of fixtures)
      rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an unsharded run records no shard and a malformed shard is refused", () => {
  const fixture = createFixture();
  try {
    const { evidence } = runFixture(fixture, false, { caseJobs: "1" });
    assert.equal(evidence.shard, null);
    for (const value of ["0/3", "4/3", "a/b", "1/0", "1", "1/3/3", " 1/3"]) {
      const { result } = runShard(fixture, value, "refused.json");
      assert.equal(result.status, 1, value);
      assert.match(result.stderr, /Shard/);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function runShard(fixture, shard, name) {
  const output = join(fixture.root, name);
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--fixture",
      fixture.root,
      "--dad-test",
      fixture.native,
      "--output",
      output,
      "--shard",
      shard,
    ],
    { encoding: "utf8", env: { ...process.env, DADS_TEST_FAIL_BASELINE: "0" } },
  );
  return {
    result,
    evidence:
      result.status === 0 ? JSON.parse(readFileSync(output, "utf8")) : null,
  };
}

function resourceProbe(fixture, idleFraction) {
  const probe = join(fixture.root, "resource-probe.mjs");
  writeFileSync(
    probe,
    `
import os from 'node:os';
import process from 'node:process';
import { syncBuiltinESMExports } from 'node:module';
let samples = 0;
os.availableParallelism = () => 6;
os.cpus = () => {
  samples += 1;
  return Array.from({length: 6}, () => ({times: {
    idle: samples * 100 * ${idleFraction},
    user: samples * 100 * ${1 - idleFraction}, sys: 0, nice: 0, irq: 0,
  }}));
};
os.freemem = () => 16 * 2 ** 30;
process.availableMemory = () => 16 * 2 ** 30;
syncBuiltinESMExports();
`,
  );
  return probe;
}
