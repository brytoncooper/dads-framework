import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  createFixture,
  events,
  runFixture,
} from "./testing-soundness-test-fixture.mjs";

test("CLI executes a fresh baseline once and isolates every mutation and native run", () => {
  const fixture = createFixture();
  try {
    for (let invocation = 1; invocation <= 2; invocation += 1) {
      writeFileSync(join(fixture.baseline, "input.txt"), "pristine");
      const { result, evidence } = runFixture(fixture, false, {
        caseJobs: "1",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(evidence.summary.status, "pass");
      assert.deepEqual(
        events(fixture),
        Array.from({ length: invocation }, () => [
          "baseline",
          "alpha",
          "native:alpha",
          "beta",
          "native:beta",
        ]).flat(),
      );
      assert.deepEqual(evidence.executionCounts, {
        baselineTasks: 1,
        mutantTasks: 2,
        nativeTasks: 2,
        nativeInvocations: 2,
      });
      assert.equal(evidence.baseline.outcomes.length, 1);
      assert.equal(typeof evidence.baseline.tree, "string");
      assert.equal(typeof evidence.baseline.manifestSha256, "string");
      for (const result of evidence.cases) {
        assert.equal(result.base, evidence.baseline.base);
        assert.deepEqual(result.changedTaskIds, ["fixture:test"]);
        assert.deepEqual(result.selectedTaskIds, ["fixture:test"]);
        assert.ok(result.outcomes.baseline[0].durationMs >= 0);
        assert.ok(result.outcomes.mutated[0].durationMs >= 0);
      }
      for (const phase of [
        "totalMs",
        "baselineMs",
        "setupMs",
        "mutantMs",
        "nativeMs",
      ]) {
        assert.ok(evidence.timings[phase] >= 0, phase);
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI records baseline failure before executing any mutation or native plan", () => {
  const fixture = createFixture();
  try {
    const { result, evidence } = runFixture(fixture, true, { caseJobs: "1" });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(events(fixture), ["baseline"]);
    assert.equal(evidence.summary.status, "fail");
    assert.match(
      evidence.baseline.executionError,
      /Baseline tasks did not pass/,
    );
    assert.deepEqual(evidence.executionCounts, {
      baselineTasks: 1,
      mutantTasks: 0,
      nativeTasks: 0,
      nativeInvocations: 0,
    });
    assert.equal(evidence.cases.length, 0);
    assert.equal(evidence.executionFailures[0].phase, "baseline");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
