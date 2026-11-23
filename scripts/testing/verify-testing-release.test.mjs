import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  main,
  parseTestingReleaseArguments,
  ReleaseUsageError,
  verifyTestingReleaseEvidence,
} from "./verify-testing-release.mjs";

const sealedCaseIds = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "..", "..", "fixtures", "testing-soundness", "cases.json"), "utf8"),
)
  .cases.map((testCase) => testCase.id)
  .sort((left, right) => left.localeCompare(right));

function soundnessEvidence(overrides = {}) {
  const taskIds = ["fixture:test"];
  return {
    schemaVersion: 2,
    kind: "dads-testing-soundness",
    sourceSha: "c735373b00cc25fdb35c3e95c6e9da6764510dc8",
    summary: {
      cases: 1,
      falseNegatives: 0,
      skippedChangedOutcomes: 0,
      executionFailures: 0,
      unexpectedSelections: 0,
      fallbackPolicyFailures: 0,
      status: "pass",
    },
    falseNegatives: [],
    unexpectedSelections: [],
    fallbackPolicyFailures: [],
    executionFailures: [],
    corpus: {
      caseIds: ["fixture-control"],
      declaredTaskIds: taskIds,
      tasks: [{ id: "fixture:test", dependsOn: [] }],
    },
    cases: [
      {
        id: "fixture-control",
        classification: "control",
        expectedChangedTaskIds: [],
        changedTaskIds: [],
        skippedChangedOutcomes: [],
        failedTaskIds: [],
        outcomes: {
          baseline: [{ id: "fixture:test", status: "passed", exitCode: 0 }],
          mutated: [{ id: "fixture:test", status: "passed", exitCode: 0 }],
        },
        taskDecisions: [{ id: "fixture:test", decision: "run" }],
        nativeRun: {
          exitCode: 0,
          counts: { executed: 1, failed: 0, blocked: 0, notApplicable: 0 },
          tasks: [{ id: "fixture:test", status: "executed", exitCode: 0 }],
        },
      },
    ],
    ...overrides,
  };
}

test("accepts passing soundness evidence", () => {
  const soundness = soundnessEvidence();
  const result = verifyTestingReleaseEvidence({ soundness });
  assert.deepEqual(result, {
    ok: true,
    failures: [],
    sourceSha: soundness.sourceSha,
  });
});

test("rejects soundness evidence with the wrong kind", () => {
  const result = verifyTestingReleaseEvidence({
    soundness: soundnessEvidence({ kind: "something-else" }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((message) => message.includes("wrong kind")));
});

test("rejects a false-negative, whether flagged by count or by status", () => {
  for (const summaryOverrides of [{ falseNegatives: 1 }, { status: "fail" }]) {
    const result = verifyTestingReleaseEvidence({
      soundness: soundnessEvidence({
        summary: { ...soundnessEvidence().summary, ...summaryOverrides },
      }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((message) => message.includes("false-negative")));
  }
});

test("rejects an unexpected precision-case selection", () => {
  const result = verifyTestingReleaseEvidence({
    soundness: soundnessEvidence({
      summary: { ...soundnessEvidence().summary, unexpectedSelections: 1 },
    }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((message) => message.includes("precision-case")));
});

test("rejects a fallback-policy failure", () => {
  const result = verifyTestingReleaseEvidence({
    soundness: soundnessEvidence({
      summary: { ...soundnessEvidence().summary, fallbackPolicyFailures: 1 },
    }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((message) => message.includes("precision collapse")));
});

test("rejects a clean summary that omits a skipped changed failing task", () => {
  const soundness = soundnessEvidence();
  const testCase = soundness.cases[0];
  testCase.classification = "breaking";
  testCase.expectedChangedTaskIds = ["fixture:test"];
  testCase.changedTaskIds = ["fixture:test"];
  testCase.skippedChangedOutcomes = [];
  testCase.failedTaskIds = ["fixture:test"];
  testCase.outcomes.mutated[0] = {
    id: "fixture:test",
    status: "failed",
    exitCode: 1,
  };
  testCase.taskDecisions[0].decision = "skip-proven-unaffected";
  testCase.nativeRun.tasks[0].status = "not-applicable";
  testCase.nativeRun.tasks[0].exitCode = null;
  testCase.nativeRun.exitCode = 0;
  testCase.nativeRun.counts = {
    executed: 0,
    failed: 0,
    blocked: 0,
    notApplicable: 1,
  };
  const result = verifyTestingReleaseEvidence({ soundness });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((message) => message.includes("selected plan omitted a changed task outcome")));
});

test("rejects a native receipt that claims success for a failed oracle task", () => {
  const soundness = soundnessEvidence();
  const testCase = soundness.cases[0];
  testCase.classification = "breaking";
  testCase.expectedChangedTaskIds = ["fixture:test"];
  testCase.changedTaskIds = ["fixture:test"];
  testCase.failedTaskIds = ["fixture:test"];
  testCase.outcomes.mutated[0] = {
    id: "fixture:test",
    status: "failed",
    exitCode: 1,
  };
  const result = verifyTestingReleaseEvidence({ soundness });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((message) => message.includes("disagrees")));
});

test("rejects an unexplained blocked native receipt", () => {
  const soundness = soundnessEvidence();
  soundness.cases[0].nativeRun.tasks[0].status = "blocked";
  soundness.cases[0].nativeRun.tasks[0].exitCode = null;
  soundness.cases[0].nativeRun.exitCode = 1;
  soundness.cases[0].nativeRun.counts = {
    executed: 0,
    failed: 0,
    blocked: 1,
    notApplicable: 0,
  };
  const result = verifyTestingReleaseEvidence({ soundness });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((message) => message.includes("blocked")));
});

test("parseTestingReleaseArguments accepts one file per shard", () => {
  const parsed = parseTestingReleaseArguments(["--soundness", "a.json", "--soundness", "b.json"]);
  assert.deepEqual(parsed["--soundness"], [resolve("a.json"), resolve("b.json")]);
});

test("parseTestingReleaseArguments rejects bad input with ReleaseUsageError", () => {
  const invalidArgumentLists = [
    [],
    ["--unknown", "value"],
    ["--soundness", "a.json", "--soundness", "a.json"],
    ["--soundness"],
    ["--soundness", "--other"],
  ];
  for (const argumentsList of invalidArgumentLists) {
    assert.throws(() => parseTestingReleaseArguments(argumentsList), ReleaseUsageError);
  }
  assert.throws(() => parseTestingReleaseArguments("--soundness"), ReleaseUsageError);
});

test("main accepts passing evidence read from disk", () => {
  const fixture = createFixture(soundnessEvidence());
  try {
    const response = main(fixture.argumentsList);
    assert.equal(response.code, 0, JSON.stringify(response.result));
    assert.equal(response.result.ok, true);
  } finally {
    fixture.cleanup();
  }
});

test("main rejects failing evidence read from disk", () => {
  const fixture = createFixture(
    soundnessEvidence({
      summary: {
        cases: 1,
        falseNegatives: 1,
        skippedChangedOutcomes: 0,
        executionFailures: 0,
        unexpectedSelections: 0,
        fallbackPolicyFailures: 0,
        status: "fail",
      },
    }),
  );
  try {
    const response = main(fixture.argumentsList);
    assert.equal(response.code, 1);
    assert.equal(response.result.ok, false);
  } finally {
    fixture.cleanup();
  }
});

test("main reports a usage error when no arguments are given", () => {
  const response = main([]);
  assert.equal(response.code, 2);
  assert.equal(response.result.ok, false);
  assert.ok(response.result.failures[0].length > 0);
});

test("main reports a read error for a nonexistent path", () => {
  const response = main(["--soundness", "/nonexistent/soundness.json"]);
  assert.equal(response.code, 1);
  assert.equal(response.result.ok, false);
});

test("merges shards that together run the sealed corpus exactly once", () => {
  const fixture = createFixture(shardEvidence(1, 2), shardEvidence(2, 2));
  try {
    const response = main(fixture.argumentsList);
    assert.equal(response.code, 0, JSON.stringify(response.result));
    assert.equal(response.result.ok, true);
    assert.deepEqual(
      response.result.shards.map((shard) => shard.index),
      [1, 2],
    );
    assert.equal(
      response.result.shards.reduce((total, shard) => total + shard.cases, 0),
      sealedCaseIds.length,
    );
  } finally {
    fixture.cleanup();
  }
});

test("names the corpus cases a missing shard never ran", () => {
  const fixture = createFixture(shardEvidence(1, 2));
  try {
    const response = main(fixture.argumentsList);
    assert.equal(response.code, 1);
    const [failure] = response.result.failures;
    assert.match(failure, /did not run corpus cases/);
    for (const id of shardCaseIds(2, 2)) assert.ok(failure.includes(id));
  } finally {
    fixture.cleanup();
  }
});

test("rejects shards that run the same case twice", () => {
  const repeated = shardCaseIds(2, 1)[0];
  const overlapping = shardEvidence(2, 2, [...shardCaseIds(2, 2), repeated]);
  const fixture = createFixture(shardEvidence(1, 2), overlapping);
  try {
    const response = main(fixture.argumentsList);
    assert.equal(response.code, 1);
    assert.ok(
      response.result.failures.some(
        (message) => message.includes("ran the same case twice") && message.includes(repeated),
      ),
      JSON.stringify(response.result.failures),
    );
  } finally {
    fixture.cleanup();
  }
});

test("rejects shards that disagree about the tools they ran", () => {
  const second = shardEvidence(2, 2);
  second.toolVersions = { ...second.toolVersions, vitest: "4.1.10" };
  const fixture = createFixture(shardEvidence(1, 2), second);
  try {
    const response = main(fixture.argumentsList);
    assert.equal(response.code, 1);
    assert.deepEqual(response.result.failures, ["soundness shards disagree on toolVersions"]);
  } finally {
    fixture.cleanup();
  }
});

function shardCaseIds(count, index) {
  const owned = [];
  sealedCaseIds.forEach((id, position) => {
    if (position % count === index - 1) owned.push(id);
  });
  return owned;
}

function shardEvidence(index, count, caseIds = shardCaseIds(count, index)) {
  const base = soundnessEvidence();
  return {
    ...base,
    toolVersions: { node: "v24.20.0", vitest: "4.1.11" },
    baseline: { base: "3f1c", tree: "9ab2", outcomes: [] },
    corpus: { ...base.corpus, caseIds: sealedCaseIds },
    shard: { index, count, caseIds },
    summary: { ...base.summary, cases: caseIds.length },
    cases: caseIds.map((id) => ({ ...base.cases[0], id })),
  };
}

function createFixture(...documents) {
  const directory = mkdtempSync(join(tmpdir(), "verify-testing-release-"));
  const argumentsList = [];
  documents.forEach((document, position) => {
    const path = join(directory, `soundness-${position}.json`);
    writeFileSync(path, JSON.stringify(document));
    argumentsList.push("--soundness", path);
  });
  return {
    argumentsList,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
