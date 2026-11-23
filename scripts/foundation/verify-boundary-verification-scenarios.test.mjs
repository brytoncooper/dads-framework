/**
 * The scenario list is the proof's inventory, so this test is the count.
 *
 * Splitting one long sequence into units that run at the same time is only
 * honest if the same scenarios are still asserted, under the same names, in the
 * same declared order. Driving every unit against a recording stub costs
 * milliseconds and says exactly that, without running a single verification.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { boundaryScenarios, proveBaseline } from "./verify-boundary-verification-scenarios.mjs";

const EXPECTED_SCENARIOS = [
  "baseline",
  "clean checkout fallback",
  "clean checkout full fallback",
  "unchanged artifact",
  "unchanged artifact in CI",
  "changed artifact",
  "injected consumer failure",
  "injected consumer failure full",
  "injected Vitest failure",
  "injected type-test failure",
  "consumer source",
  "consumer test",
  "consumer config",
  "engine",
  "binding",
  "lockfile",
  "toolchain runner version",
  "declared environment",
  "missing receipt",
  "corrupt receipt",
  "provider failure",
  "full",
];

test("every declared scenario still asserts, in order", async () => {
  const asserted = [];
  const baseline = recordingSeat(asserted);
  await proveBaseline(baseline);
  for (const scenario of boundaryScenarios) {
    await scenario.run(recordingSeat(asserted));
  }
  assert.deepEqual(asserted, EXPECTED_SCENARIOS);
});

test("every scenario changes something before it verifies", async () => {
  for (const scenario of boundaryScenarios) {
    const asserted = [];
    const seat = recordingSeat(asserted);
    await scenario.run(seat);
    assert.ok(
      seat.edits.length > 0 || scenario.name.startsWith("clean checkout"),
      `${scenario.name} verified without changing anything.`,
    );
  }
});

test("a scenario declares a positive cost so the pool can order it", () => {
  for (const scenario of boundaryScenarios) {
    assert.ok(
      Number.isFinite(scenario.cost) && scenario.cost > 0,
      `${scenario.name} declared cost ${JSON.stringify(scenario.cost)}.`,
    );
  }
});

/** A project and its expectations that do nothing but write down what happened. */
function recordingSeat(asserted) {
  const edits = [];
  const report = { counts: {}, results: [] };
  return {
    edits,
    project: {
      prepareIsolatedProject() {},
      commit() {},
      read: () => "",
      append: (path) => edits.push(`append ${path}`),
      write: (path) => edits.push(`write ${path}`),
      replace: (path) => edits.push(`replace ${path}`),
      removeConsumerReceipts: () => edits.push("remove receipts"),
      corruptConsumerReceipts: () => edits.push("corrupt receipts"),
      updateManifest(update) {
        edits.push("update manifest");
        update(stubManifest());
      },
    },
    expectations: {
      runVerification: () => Promise.resolve(report),
      expectStates: (name) => asserted.push(name),
      expectAllExecuted: (name) => asserted.push(name),
      expectConsumerFailed: (name) => asserted.push(name),
      expectTaskFailed: (name) => asserted.push(name),
      expectConsumerExecuted: (name) => {
        asserted.push(name);
        return Promise.resolve();
      },
    },
  };
}

function stubManifest() {
  return {
    verification: {
      tasks: [
        {
          id: "consumer:artifact-check",
          execution: {
            runnerVersion: "boundary-consumer-v1",
            environment: [{ name: "BOUNDARY_FIXTURE_MODE", value: "x" }],
          },
        },
      ],
    },
  };
}
