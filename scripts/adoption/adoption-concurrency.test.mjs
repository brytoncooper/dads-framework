import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";

import { adoptionJobsFromResources, firstFailure, runTaskPool } from "./adoption-concurrency.mjs";

function resources(overrides = {}) {
  return {
    cpuCapacity: 16,
    cpuIdleFraction: 1,
    availableMemoryBytes: 64 * 1024 ** 3,
    probeErrors: [],
    ...overrides,
  };
}

test("spends the idle machine minus one core", () => {
  const receipt = adoptionJobsFromResources(undefined, 100, resources());

  assert.equal(receipt.mode, "auto");
  assert.equal(receipt.cpuBudget, 15);
  assert.equal(receipt.jobs, 15);
  assert.deepEqual(receipt.limitingReasons, ["cpu-budget"]);
});

test("takes a busy machine's idle fraction seriously", () => {
  const receipt = adoptionJobsFromResources(undefined, 100, resources({ cpuCapacity: 8, cpuIdleFraction: 0.5 }));

  assert.equal(receipt.jobs, 3);
});

test("never returns less than one job", () => {
  const receipt = adoptionJobsFromResources(undefined, 100, resources({ cpuCapacity: 1, cpuIdleFraction: 0.1 }));

  assert.equal(receipt.jobs, 1);
});

test("lets memory bind before the cores do", () => {
  const receipt = adoptionJobsFromResources(undefined, 100, resources({ availableMemoryBytes: 4 * 1024 ** 3 }));

  assert.equal(receipt.memoryBudget, 4);
  assert.equal(receipt.jobs, 4);
  assert.deepEqual(receipt.limitingReasons, ["memory-budget"]);
});

test("never queues more jobs than there are tasks", () => {
  const receipt = adoptionJobsFromResources(undefined, 3, resources());

  assert.equal(receipt.jobs, 3);
  assert.ok(receipt.limitingReasons.includes("task-count"));
});

test("falls back to one job when the probe failed", () => {
  const receipt = adoptionJobsFromResources(
    undefined,
    10,
    resources({ probeErrors: ["CPU probe: sample inventory changed"] }),
  );

  assert.equal(receipt.jobs, 1);
  assert.deepEqual(receipt.limitingReasons, ["resource-probe-unavailable"]);
});

test("an explicit override wins and is recorded as one", () => {
  const receipt = adoptionJobsFromResources("4", 10, resources());

  assert.equal(receipt.mode, "explicit");
  assert.equal(receipt.jobs, 4);
  assert.equal(receipt.resources, null);
  assert.deepEqual(receipt.limitingReasons, ["explicit-override"]);
});

test("rejects an override that is not a positive integer", () => {
  assert.throws(() => adoptionJobsFromResources("0", 10, resources()), /DADS_ADOPTION_JOBS/);
  assert.throws(() => adoptionJobsFromResources("many", 10, resources()), /DADS_ADOPTION_JOBS/);
});

test("an empty task list spends nothing", () => {
  const receipt = adoptionJobsFromResources(undefined, 0, null);

  assert.equal(receipt.jobs, 0);
  assert.deepEqual(receipt.limitingReasons, ["no-tasks"]);
});

test("never runs more tasks at once than the job budget", async () => {
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    name: `task-${index}`,
    run: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
    },
  }));

  const results = await runTaskPool(tasks, 3);

  assert.equal(peak, 3);
  assert.deepEqual(
    results.map((result) => result.status),
    Array.from({ length: 12 }, () => "ok"),
  );
  assert.deepEqual(
    results.map((result) => result.name),
    tasks.map((task) => task.name),
  );
});

test("stops starting tasks after a failure and blames the declared order", async () => {
  const started = [];
  const tasks = Array.from({ length: 6 }, (_, index) => ({
    name: `task-${index}`,
    run: async () => {
      started.push(index);
      await new Promise((resolve) => setImmediate(resolve));
      if (index === 1 || index === 0) throw new Error(`task ${index} failed`);
    },
  }));

  const results = await runTaskPool(tasks, 2);

  assert.equal(results[0].status, "failed");
  assert.equal(results[1].status, "failed");
  assert.deepEqual(
    results.slice(2).map((result) => result.status),
    ["skipped", "skipped", "skipped", "skipped"],
  );
  assert.equal(firstFailure(results).name, "task-0");
  assert.deepEqual(started, [0, 1]);
});

test("starts the longest task first and still reports in declared order", async () => {
  const started = [];
  const task = (name, cost) => ({
    name,
    cost,
    run: async () => {
      started.push(name);
    },
  });

  const results = await runTaskPool([task("import", 2), task("fixture", 5), task("boundary", 40)], 1);

  assert.deepEqual(started, ["boundary", "fixture", "import"]);
  assert.deepEqual(
    results.map((result) => result.name),
    ["import", "fixture", "boundary"],
  );
});

test("keeps declared order between tasks of equal cost", async () => {
  const started = [];
  const task = (name) => ({
    name,
    run: async () => {
      started.push(name);
    },
  });

  await runTaskPool([task("a"), task("b"), task("c")], 1);

  assert.deepEqual(started, ["a", "b", "c"]);
});

test("refuses a cost that is not a positive number", async () => {
  await assert.rejects(
    () => runTaskPool([{ name: "bad", cost: 0, run: async () => {} }], 1),
    /Task bad declared a cost/,
  );
});

test("reports no failure for a clean run", async () => {
  const results = await runTaskPool([{ name: "one", run: async () => {} }], 1);

  assert.equal(firstFailure(results), null);
  assert.ok(results[0].durationMs >= 0);
});

test("refuses a job budget that is not a positive integer", async () => {
  await assert.rejects(() => runTaskPool([], 0), /positive safe integer/);
});
