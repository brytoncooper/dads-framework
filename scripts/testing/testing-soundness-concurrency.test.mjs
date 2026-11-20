import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import {
  caseConcurrencyFromResources,
  chooseCaseConcurrency,
  orderedConcurrentMap,
} from "./testing-soundness-concurrency.mjs";

const gibibyte = 1024 ** 3;
const healthy = {
  cpuCapacity: 16,
  cpuIdleFraction: 0.9,
  availableMemoryBytes: 12 * gibibyte,
  sampleDurationMs: 250,
  probeErrors: [],
};

test("automatic concurrency spends one task budget on tasks and cases together", () => {
  const receipt = caseConcurrencyFromResources("auto", 21, healthy, 3);
  assert.equal(receipt.mode, "auto");
  assert.equal(receipt.cpuBudget, 13);
  assert.equal(receipt.memoryBudget, 11);
  assert.equal(receipt.taskGraphWidth, 3);
  assert.equal(receipt.taskJobs, 3);
  assert.equal(receipt.caseJobs, 4);
  assert.ok(receipt.caseJobs * receipt.taskJobs <= receipt.cpuBudget);
  assert.ok(receipt.limitingReasons.includes("cpu-budget"));
  assert.ok(receipt.limitingReasons.includes("task-graph-width"));
  assert.equal(receipt.nativeJobs, 3);
  assert.equal(receipt.vitestMaxWorkers, 1);
  assert.deepEqual(receipt.resources, healthy);
  assert.doesNotThrow(() => JSON.stringify(receipt));
});

test("a single-file task graph spends the whole budget on cases", () => {
  const receipt = caseConcurrencyFromResources("auto", 21, healthy);
  assert.equal(receipt.taskGraphWidth, 1);
  assert.equal(receipt.taskJobs, 1);
  assert.equal(receipt.caseJobs, 11);
  assert.ok(receipt.limitingReasons.includes("memory-budget"));
  const wide = caseConcurrencyFromResources("auto", 21, healthy, 99);
  assert.equal(wide.taskJobs, 13);
  assert.equal(wide.caseJobs, 1);
  assert.ok(!wide.limitingReasons.includes("task-graph-width"));
});

test("CPU and memory pressure retain one runnable case without claiming spare capacity", () => {
  const busy = caseConcurrencyFromResources(
    undefined,
    21,
    { ...healthy, cpuIdleFraction: 0.05 },
    3,
  );
  assert.equal(busy.cpuBudget, 1);
  assert.equal(busy.taskJobs, 1);
  assert.equal(busy.caseJobs, 1);
  assert.ok(busy.limitingReasons.includes("cpu-budget"));
  const lowMemory = caseConcurrencyFromResources("auto", 21, {
    ...healthy,
    availableMemoryBytes: gibibyte / 2,
  });
  assert.equal(lowMemory.caseJobs, 1);
  assert.equal(lowMemory.memoryBudget, 0);
  assert.ok(lowMemory.limitingReasons.includes("memory-budget"));
  assert.ok(lowMemory.limitingReasons.includes("minimum-one-case"));
  const exactMemory = caseConcurrencyFromResources("auto", 21, {
    ...healthy,
    availableMemoryBytes: 3 * gibibyte,
  });
  assert.equal(exactMemory.caseJobs, 2);
  assert.equal(exactMemory.memoryBudget, 2);
  const tinyCorpus = caseConcurrencyFromResources("auto", 2, healthy);
  assert.equal(tinyCorpus.caseJobs, 2);
  assert.ok(tinyCorpus.limitingReasons.includes("case-count"));
});

test("invalid or unavailable resource samples conservatively choose one case", () => {
  for (const resources of [
    null,
    { ...healthy, cpuCapacity: 0 },
    { ...healthy, cpuCapacity: 1.5 },
    { ...healthy, cpuIdleFraction: NaN },
    { ...healthy, cpuIdleFraction: -0.1 },
    { ...healthy, cpuIdleFraction: 1.1 },
    { ...healthy, availableMemoryBytes: Infinity },
    { ...healthy, availableMemoryBytes: -1 },
    { ...healthy, sampleDurationMs: 0 },
    { ...healthy, probeErrors: ["CPU sample unavailable"] },
  ]) {
    const receipt = caseConcurrencyFromResources("auto", 21, resources, 3);
    assert.equal(receipt.caseJobs, 1);
    assert.equal(receipt.taskJobs, 1);
    assert.ok(receipt.limitingReasons.includes("resource-probe-unavailable"));
    assert.doesNotThrow(() => JSON.stringify(receipt));
  }
});

test("explicit overrides run one task at a time and are capped by case count", async () => {
  const explicit = await chooseCaseConcurrency("3", 21, 3);
  assert.equal(explicit.caseJobs, 3);
  assert.equal(explicit.taskJobs, 1);
  assert.equal(explicit.nativeJobs, 1);
  const capped = await chooseCaseConcurrency("99", 2);
  assert.equal(capped.mode, "explicit");
  assert.equal(capped.caseJobs, 2);
  assert.equal(capped.resources, null);
  for (const invalid of [
    "0",
    "-1",
    "1.5",
    "1e2",
    "Infinity",
    "NaN",
    "",
    " 2",
    "+2",
    "02",
    "9007199254740992",
    2,
    null,
  ]) {
    await assert.rejects(
      chooseCaseConcurrency(invalid, 21),
      /positive safe integer/,
    );
  }
  assert.equal((await chooseCaseConcurrency("auto", 0)).caseJobs, 0);
  assert.equal((await chooseCaseConcurrency("2", 0)).caseJobs, 0);
  await assert.rejects(chooseCaseConcurrency("auto", -1), /case count/);
});

test("an invalid task graph width is refused rather than guessed", async () => {
  for (const width of [0, -1, 1.5, NaN, Infinity, "3", null]) {
    await assert.rejects(
      chooseCaseConcurrency("auto", 21, width),
      /task graph width/,
    );
    assert.throws(
      () => caseConcurrencyFromResources("auto", 21, healthy, width),
      /task graph width/,
    );
  }
});

test("pool bounds active workers, executes each item once and preserves input order", async () => {
  const gates = Array.from({ length: 5 }, deferred);
  const starts = Array.from({ length: 5 }, deferred);
  const visited = [];
  let active = 0;
  let maximum = 0;
  const result = orderedConcurrentMap([0, 1, 2, 3, 4], 2, async (item) => {
    visited.push(item);
    active += 1;
    maximum = Math.max(maximum, active);
    starts[item].resolve();
    await gates[item].promise;
    active -= 1;
    return `result-${item}`;
  });
  await Promise.all([starts[0].promise, starts[1].promise]);
  assert.deepEqual(visited, [0, 1]);
  gates[1].resolve();
  await starts[2].promise;
  gates[2].resolve();
  await starts[3].promise;
  gates[3].resolve();
  await starts[4].promise;
  gates[4].resolve();
  gates[0].resolve();
  assert.deepEqual(await result, [
    "result-0",
    "result-1",
    "result-2",
    "result-3",
    "result-4",
  ]);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.deepEqual(visited, [0, 1, 2, 3, 4]);
});

test("pool drains started workers before rejecting and does not start queued work", async () => {
  const failure = deferred();
  const sibling = deferred();
  const bothStarted = deferred();
  const visited = [];
  const expectedError = new Error("worker failed");
  let settled = false;
  const result = orderedConcurrentMap([0, 1, 2], 2, async (item) => {
    visited.push(item);
    if (visited.length === 2) bothStarted.resolve();
    if (item === 0) {
      await failure.promise;
      throw expectedError;
    }
    await sibling.promise;
    return item;
  }).then(
    () => {
      settled = true;
      return null;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await bothStarted.promise;
  failure.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(visited, [0, 1]);
  sibling.resolve();
  assert.equal(await result, expectedError);
  assert.deepEqual(visited, [0, 1]);
});

test("pool handles empty input and rejects invalid limits", async () => {
  assert.deepEqual(await orderedConcurrentMap([], 0, async (item) => item), []);
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(
      orderedConcurrentMap([1], limit, async (item) => item),
      /positive safe integer/,
    );
  }
});

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}

test("a budget that does not divide evenly rounds to the nearer case count", () => {
  const eleven = {
    cpuCapacity: 12,
    cpuIdleFraction: 1,
    availableMemoryBytes: 64 * 1024 ** 3,
    sampleDurationMs: 250,
    probeErrors: [],
  };
  const receipt = caseConcurrencyFromResources("auto", 21, eleven, 3);
  assert.equal(receipt.cpuBudget, 11);
  assert.equal(receipt.taskJobs, 3);
  assert.equal(receipt.caseJobs, 4);
  assert.ok(receipt.caseJobs * receipt.taskJobs <= receipt.cpuBudget + 1);
});
