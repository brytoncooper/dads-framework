/**
 * Proves the verify runner's scheduling rules with fake steps.
 *
 * Every step here is a real child process (`node -e`), so the assertions are
 * about processes that actually overlapped in time rather than about a
 * simulation of them. They sleep in tens of milliseconds, so the whole file
 * runs in about a second.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";

import { budgetFromResources, budgetReceipt, requestedBudget, sampleVerifyResources } from "./verify-budget.mjs";
import { VERIFY_STEPS, topologicalOrder, verifySteps } from "./verify-graph.mjs";
import { criticalPath } from "./verify-report.mjs";
import { runVerifyGraph, slotsFor } from "./verify-scheduler.mjs";
import { spawnStep } from "./verify-spawn.mjs";
import { resolveVitestMaxWorkers } from "./verify-test-step.mjs";

const GIBIBYTE = 1024 ** 3;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A step that stays alive for `ms` and then exits 0. */
function sleeper(id, { needs = [], weight = 1, ms = 80 } = {}) {
  return {
    id,
    command: process.execPath,
    args: ["-e", `setTimeout(() => {}, ${ms});`],
    needs,
    weight,
  };
}

/** A step that writes to both streams and exits with `code`. */
function failer(id, code, { needs = [], weight = 1, ms = 10 } = {}) {
  const body = `console.log("out ${id}"); console.error("err ${id}"); setTimeout(() => process.exit(${code}), ${ms});`;
  return { id, command: process.execPath, args: ["-e", body], needs, weight };
}

/** Runs a graph for real and records what overlapped with what. */
async function run(steps, options = {}) {
  const running = new Set();
  const overlaps = [];
  const startOrder = [];
  const peak = { size: 0 };
  const onEvent = (event) => {
    if (event.type === "start") {
      startOrder.push(event.step.id);
      overlaps.push(new Set([...running, event.step.id]));
      running.add(event.step.id);
      peak.size = Math.max(peak.size, running.size);
    }
    if (event.type === "finish") running.delete(event.step.id);
  };
  const outcome = await runVerifyGraph({
    steps,
    budget: options.budget ?? 8,
    serial: options.serial === true,
    failFast: options.failFast === true,
    runStep: (step) => spawnStep(step, ROOT),
    onEvent,
  });
  return { ...outcome, overlaps, startOrder, peak: peak.size };
}

function statusOf(outcome, id) {
  return outcome.results.find((result) => result.step.id === id)?.status;
}

test("topological order puts every step after everything it needs", () => {
  const seen = new Set();
  for (const step of topologicalOrder(VERIFY_STEPS)) {
    for (const need of step.needs) {
      assert.ok(seen.has(need), `${step.id} ran before its need ${need}`);
    }
    seen.add(step.id);
  }
  assert.equal(topologicalOrder(VERIFY_STEPS).length, VERIFY_STEPS.length);
});

test("a need that names no declared step fails loudly", () => {
  assert.throws(
    () => topologicalOrder([sleeper("a", { needs: ["ghost"] })]),
    /needs "ghost", which is not a declared step/u,
  );
});

test("a cycle fails loudly instead of running", () => {
  const steps = [sleeper("a", { needs: ["b"] }), sleeper("b", { needs: ["a"] })];
  assert.throws(() => topologicalOrder(steps), /cycle/u);
});

test("an all-weight step never runs beside another all-weight step", async () => {
  const steps = [
    sleeper("wide-one", { weight: "all", ms: 150 }),
    sleeper("wide-two", { weight: "all", ms: 150 }),
    sleeper("light-one", { ms: 150 }),
    sleeper("light-two", { ms: 150 }),
  ];
  const outcome = await run(steps, { budget: 8 });
  for (const overlap of outcome.overlaps) {
    const wide = [...overlap].filter((id) => id.startsWith("wide-")).length;
    assert.ok(wide <= 1, `two all-weight steps overlapped: ${[...overlap]}`);
  }
  assert.ok(
    outcome.overlaps.some((overlap) => overlap.size > 1),
    "light steps should still run beside an all-weight step",
  );
  assert.equal(outcome.exitCode, 0);
});

test("the running weights stay inside the budget", async () => {
  const steps = [
    sleeper("heavy-one", { weight: 2, ms: 120 }),
    sleeper("heavy-two", { weight: 2, ms: 120 }),
    sleeper("heavy-three", { weight: 2, ms: 120 }),
  ];
  const outcome = await run(steps, { budget: 4 });
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const overlap of outcome.overlaps) {
    const weight = [...overlap].reduce((total, id) => total + slotsFor(byId.get(id), 4), 0);
    assert.ok(weight <= 4, `overlap weighed ${weight}: ${[...overlap]}`);
  }
});

test("a failure blocks its dependents and yields the first exit code", async () => {
  const steps = [
    failer("breaks", 3, { ms: 10 }),
    sleeper("depends-on-broken", { needs: ["breaks"], ms: 20 }),
    sleeper("depends-transitively", { needs: ["depends-on-broken"], ms: 20 }),
    failer("breaks-later", 4, { ms: 200 }),
    sleeper("unrelated", { ms: 20 }),
  ];
  const outcome = await run(steps, { budget: 8 });
  assert.equal(outcome.exitCode, 3);
  assert.equal(statusOf(outcome, "breaks"), "failed");
  assert.equal(statusOf(outcome, "depends-on-broken"), "blocked");
  assert.equal(statusOf(outcome, "depends-transitively"), "blocked");
  assert.equal(statusOf(outcome, "unrelated"), "passed");
  assert.equal(statusOf(outcome, "breaks-later"), "failed");
});

test("a failing step keeps everything it wrote to both streams", async () => {
  const outcome = await run([failer("noisy", 2)], { budget: 4 });
  const result = outcome.results[0];
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /out noisy/u);
  assert.match(result.output, /err noisy/u);
});

test("fail-fast starts nothing after the first failure", async () => {
  const steps = [
    failer("breaks", 5, { ms: 5 }),
    sleeper("late-one", { needs: ["breaks-nothing"], ms: 20 }),
    sleeper("breaks-nothing", { ms: 150 }),
    sleeper("never-started", { needs: ["late-one"], ms: 20 }),
  ];
  const outcome = await run(steps, { budget: 1, failFast: true });
  assert.equal(outcome.exitCode, 5);
  assert.equal(statusOf(outcome, "never-started"), "not-run");
});

test("serial runs the declared order, one step at a time", async () => {
  const steps = [
    sleeper("first", { ms: 20 }),
    sleeper("second", { ms: 20 }),
    sleeper("third", { needs: ["first"], ms: 20 }),
    sleeper("fourth", { weight: "all", ms: 20 }),
    sleeper("fifth", { ms: 20 }),
  ];
  const outcome = await run(steps, { budget: 1, serial: true });
  assert.deepEqual(outcome.startOrder, ["first", "second", "third", "fourth", "fifth"]);
  assert.equal(outcome.peak, 1);
  assert.equal(outcome.exitCode, 0);
});

test("a busy two-core machine buys one slot", () => {
  const budget = budgetFromResources({
    source: "test",
    cpuCapacity: 2,
    cpuIdleFraction: 0.2,
    availableMemoryBytes: 8 * GIBIBYTE,
    note: null,
  });
  assert.equal(budget.jobs, 1);
  assert.deepEqual(budget.limits, ["idle CPU", "one-job minimum"]);
});

test("an idle sixteen-core machine buys many slots", () => {
  const budget = budgetFromResources({
    source: "test",
    cpuCapacity: 16,
    cpuIdleFraction: 0.98,
    availableMemoryBytes: 48 * GIBIBYTE,
    note: null,
  });
  assert.equal(budget.jobs, 14);
  assert.deepEqual(budget.limits, ["idle CPU"]);
});

test("free memory can be the binding limit", () => {
  const budget = budgetFromResources({
    source: "test",
    cpuCapacity: 16,
    cpuIdleFraction: 1,
    availableMemoryBytes: 4 * GIBIBYTE,
    note: null,
  });
  assert.equal(budget.jobs, 3);
  assert.deepEqual(budget.limits, ["free memory"]);
});

test("the host sample is usable whether or not the corpus probe is", async () => {
  const sample = await sampleVerifyResources();
  assert.ok(["corpus probe", "os fallback"].includes(sample.source));
  assert.ok(Number.isSafeInteger(sample.cpuCapacity) && sample.cpuCapacity > 0);
  assert.ok(sample.cpuIdleFraction >= 0 && sample.cpuIdleFraction <= 1);
  assert.ok(sample.availableMemoryBytes > 0);
  const budget = budgetFromResources(sample);
  assert.ok(budget.jobs >= 1);
  assert.match(budgetReceipt(budget), /limited by/u);
  assert.equal(budgetReceipt(requestedBudget(2, "--jobs")), "budget 2 slots (--jobs)");
});

test("a requested budget refuses anything but a positive whole number", () => {
  assert.throws(() => requestedBudget(0, "--jobs"), /positive whole number/u);
  assert.throws(() => requestedBudget(1.5, "--jobs"), /positive whole number/u);
  assert.equal(requestedBudget(3, "--jobs").jobs, 3);
});

test("an all-weight step books half the budget and at least one slot", () => {
  const wide = { id: "wide", weight: "all", needs: [] };
  assert.equal(slotsFor(wide, 1), 1);
  assert.equal(slotsFor(wide, 8), 4);
  assert.equal(slotsFor(wide, 13), 7);
  assert.throws(() => slotsFor({ id: "bad", weight: 0, needs: [] }, 8), /positive whole number or "all"/u);
});

test("the critical path is the longest measured chain through the graph", () => {
  const results = [
    { step: sleeper("a"), status: "passed", durationMs: 100 },
    { step: sleeper("b", { needs: ["a"] }), status: "passed", durationMs: 200 },
    { step: sleeper("c", { needs: ["b"] }), status: "passed", durationMs: 50 },
    { step: sleeper("d"), status: "passed", durationMs: 90 },
  ];
  const path = criticalPath(results);
  assert.deepEqual(path.chain, ["a", "b", "c"]);
  assert.equal(path.total, 350);
});

test("the declared graph runs the same proofs the chain ran", () => {
  const ids = VERIFY_STEPS.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length, "step ids must be unique");
  for (const step of VERIFY_STEPS) {
    assert.ok(step.args.length > 0, `${step.id} declares no arguments`);
    assert.ok(step.weight === "all" || Number.isSafeInteger(step.weight), `${step.id} declares an unusable weight`);
  }
  const needsBuild = VERIFY_STEPS.filter((step) => step.needs.includes("build")).map((step) => step.id);
  assert.ok(needsBuild.includes("eslint"));
  assert.ok(needsBuild.includes("test"));
  assert.ok(needsBuild.includes("api-report"));
  assert.ok(needsBuild.includes("docs"));
  // The ratchet is now the product behind a wrapper, so it needs the build for
  // `dist/cli.js` as well as the test step for the Vitest report.
  assert.deepEqual(VERIFY_STEPS.find((step) => step.id === "source-budgets")?.needs, ["build", "test"]);
});

test("--full adds every proof CI runs elsewhere, behind the build and the engine", () => {
  const plain = verifySteps({ full: false }).map((step) => step.id);
  const full = verifySteps({ full: true }).map((step) => step.id);
  for (const id of ["adoption", "rust-test", "corpus", "release-evidence"]) {
    assert.ok(!plain.includes(id), `${id} must not run without --full`);
    assert.ok(full.includes(id), `${id} missing from --full`);
  }
  assert.equal(new Set(full).size, full.length, "step ids must be unique");
  const order = topologicalOrder(verifySteps({ full: true })).map((step) => step.id);
  assert.ok(order.indexOf("build") < order.indexOf("adoption"));
  assert.ok(order.indexOf("rust-format") < order.indexOf("rust-lint"));
  assert.ok(order.indexOf("rust-test") < order.indexOf("engine"));
  assert.ok(order.indexOf("engine") < order.indexOf("corpus"));
  assert.ok(order.indexOf("corpus") < order.indexOf("release-evidence"));
});

test("CI runs the full graph across independent jobs without cached results", () => {
  const workflow = readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
  const commands = [...workflow.matchAll(/^ +run: (.+)$/gmu)].map(([, command]) => command);
  assert.ok(commands.includes("npm run verify -- --no-cache --require-receipt"));
  assert.ok(commands.includes("npm run verify:adoption"));
  const rust = verifySteps({ full: true }).filter((step) => step.command === "cargo");
  for (const step of rust) {
    const command = [step.command, ...step.args].join(" ");
    assert.ok(commands.includes(command), `CI omits ${step.id}`);
  }
  assert.match(workflow, /matrix:\n +shard: \[1, 2, 3\]/u);
  assert.ok(
    commands.some((command) =>
      command.startsWith("npm run testing:soundness -- --dad-test target/debug/dad-test --shard "),
    ),
  );
  assert.match(workflow, /^ +needs: corpus$/mu);
  const evidence = commands.find((command) =>
    command.startsWith("node scripts/testing/verify-testing-release.mjs --soundness "),
  );
  assert.ok(evidence);
  for (const shard of [1, 2, 3]) {
    assert.ok(evidence.includes(`soundness-${shard}.json`));
  }
});

test("verify-test-step caps default Vitest workers to avoid Docker starvation while honoring VITEST_MAX_WORKERS", () => {
  assert.equal(resolveVitestMaxWorkers({}, 16), "4");
  assert.equal(resolveVitestMaxWorkers({}, 2), "2");
  assert.equal(resolveVitestMaxWorkers({ VITEST_MAX_WORKERS: "6" }, 16), "6");
  assert.equal(resolveVitestMaxWorkers({ VITEST_MAX_WORKERS: "  " }, 12), "4");
});
