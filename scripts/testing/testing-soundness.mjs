#!/usr/bin/env node
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  compareSoundness,
  exactSelectionDifference,
  fallbackPolicyFailureFor,
  invoke,
  jsonWrite,
  normalizeIssues,
  parseArguments,
  requireOption,
  selectedTaskIds,
  sha256File,
  stableIds,
  validateSoundnessCase,
} from "./testing-soundness-lib.mjs";
import {
  assertObservedTasks,
  compareTaskOutcomes,
  executeTasksIndependently,
  stageWorkspaceTools,
  taskGraphWidth,
  toolVersions,
} from "./testing-soundness-execution.mjs";
import {
  parseShardOption,
  shardCases,
  shardReceipt,
} from "./testing-soundness-shard.mjs";

import { SOUNDNESS_OPTIONS } from "./testing-soundness-invocation.mjs";
import { assertNativeRun } from "./testing-soundness-native.mjs";
import {
  caseProofContext,
  readSoundnessCorpus,
} from "./testing-soundness-context.mjs";
import {
  chooseCaseConcurrency,
  orderedConcurrentMap,
} from "./testing-soundness-concurrency.mjs";
import {
  cloneBaseline,
  freezeBaseline,
  git,
  observeBaseline,
  removeWorkspace,
} from "./testing-soundness-workspaces.mjs";

const startedAt = performance.now();
const timings = { baselineMs: 0, setupMs: 0, mutantMs: 0, nativeMs: 0 };
const executionCounts = {
  baselineTasks: 0,
  mutantTasks: 0,
  nativeTasks: 0,
  nativeInvocations: 0,
};
const root = resolve(process.cwd());
const argumentsByName = parseArguments(
  process.argv.slice(2),
  SOUNDNESS_OPTIONS,
);
const binary = resolve(requireOption(argumentsByName, "--dad-test"));
const output = resolve(requireOption(argumentsByName, "--output"));
const fixture = resolve(
  argumentsByName.get("--fixture") ??
    join(root, "fixtures", "testing-soundness"),
);
const baseline = join(fixture, "baseline");
const manifest = join(fixture, "dads.testing.json");
const { corpus, context: corpusContext } = readSoundnessCorpus(fixture, root);

if (!existsSync(baseline) || !existsSync(manifest))
  throw new Error(`Soundness fixture is incomplete at ${fixture}.`);
if (!Array.isArray(corpus.cases) || !Array.isArray(corpus.allTaskIds))
  throw new Error("Soundness corpus must declare allTaskIds and cases.");
const shard = parseShardOption(argumentsByName.get("--shard"));
const setupStarted = performance.now();
const frozen = freezeBaseline(baseline, manifest);
process.once("exit", () => removeWorkspace(frozen.workspace));
const declaredManifest = frozen.manifest;
assertTaskInventory(corpus.allTaskIds, declaredManifest.tasks);

for (const testCase of corpus.cases) {
  validateSoundnessCase(testCase, corpus.allTaskIds);
  caseProofContext(testCase);
}
timings.setupMs += performance.now() - setupStarted;
const orderedCases = shardCases(corpus.cases, shard);
const concurrency = await chooseCaseConcurrency(
  argumentsByName.get("--case-jobs"),
  orderedCases.length,
  taskGraphWidth(declaredManifest.tasks),
);
const executionEnvironment = {
  VITEST_MAX_WORKERS: String(concurrency.vitestMaxWorkers),
};
process.stderr.write(
  `soundness concurrency: ${concurrency.caseJobs} cases of ${concurrency.taskJobs} tasks (${concurrency.mode}; ${concurrency.limitingReasons.join(", ")})\n`,
);
if (shard !== null) {
  process.stderr.write(
    `soundness shard ${shard.index}/${shard.count}: ${orderedCases.length} of ${corpus.cases.length} cases\n`,
  );
}
const sourceSha = git(root, ["rev-parse", "HEAD"]);
const baselineReceipt = await observeBaseline(
  root,
  frozen,
  timings,
  executionEnvironment,
  concurrency.taskJobs,
);
const baselineOutcomes = baselineReceipt.outcomes;
executionCounts.baselineTasks = baselineOutcomes.filter(
  (task) => task.status !== "spawn-error",
).length;
let activeCases = 0;
let peakCases = 0;
let completedCases = 0;
const caseResults = baselineReceipt.executionError
  ? []
  : await orderedConcurrentMap(orderedCases, concurrency.caseJobs, runCase);
removeWorkspace(frozen.workspace);

async function runCase(testCase) {
  activeCases += 1;
  peakCases = Math.max(peakCases, activeCases);
  process.stderr.write(`soundness ${testCase.id}\n`);
  let oracleWorkspace;
  let nativeWorkspace;
  let mutatedOutcomes = [];
  try {
    const setupStarted = performance.now();
    oracleWorkspace = cloneBaseline(frozen, testCase);
    nativeWorkspace = cloneBaseline(frozen, testCase);
    stageWorkspaceTools(root, oracleWorkspace.workspace);
    stageWorkspaceTools(root, nativeWorkspace.workspace);
    timings.setupMs += performance.now() - setupStarted;
    const mutantStarted = performance.now();
    mutatedOutcomes = await executeTasksIndependently(
      declaredManifest.tasks,
      oracleWorkspace.workspace,
      executionEnvironment,
      concurrency.taskJobs,
    );
    timings.mutantMs += performance.now() - mutantStarted;
    executionCounts.mutantTasks += mutatedOutcomes.filter(
      (task) => task.status !== "spawn-error",
    ).length;
    assertObservedTasks(declaredManifest.tasks, mutatedOutcomes, "Mutation");
    const outcomes = compareTaskOutcomes(baselineOutcomes, mutatedOutcomes);
    assertExpectedOutcomes(testCase, outcomes.changedTaskIds);

    const nativeStarted = performance.now();
    executionCounts.nativeInvocations += 1;
    const result = await invoke(
      binary,
      nativeRequest(
        nativeWorkspace.workspace,
        nativeWorkspace.base,
        nativeWorkspace.head,
      ),
      nativeWorkspace.workspace,
      executionEnvironment,
    ).finally(() => {
      timings.nativeMs += performance.now() - nativeStarted;
    });
    executionCounts.nativeTasks += (result.run?.tasks ?? []).filter((task) =>
      ["executed", "failed"].includes(task.status),
    ).length;
    const selected = selectedTaskIds(result.plan);
    const comparison = compareSoundness(testCase.requiredTaskIds, selected);
    const nativeRun = assertNativeRun(
      result,
      declaredManifest.tasks,
      selected,
      mutatedOutcomes,
    );
    const skippedChangedOutcomes = outcomes.changedTaskIds.filter(
      (id) => !selected.includes(id),
    );
    const expectedSelectionTaskIds =
      testCase.expectedSelectionTaskIds === undefined
        ? null
        : stableIds(testCase.expectedSelectionTaskIds);
    const unexpectedSelection =
      expectedSelectionTaskIds === null
        ? null
        : exactSelectionDifference(
            expectedSelectionTaskIds,
            comparison.selected,
          );
    const fallbackPolicyFailure = fallbackPolicyFailureFor(
      testCase.fullFallbackPolicy,
      result.plan.scope.fullFallback,
    );
    return {
      id: testCase.id,
      ...caseProofContext(testCase),
      classification: testCase.classification,
      description: testCase.description,
      base: frozen.base,
      head: oracleWorkspace?.head ?? null,
      expectedChangedTaskIds: stableIds(testCase.expectedChangedTaskIds),
      changedTaskIds: outcomes.changedTaskIds,
      skippedChangedOutcomes,
      failedTaskIds: mutatedOutcomes
        .filter((outcome) => outcome.status === "failed")
        .map((outcome) => outcome.id),
      outcomes,
      changedPaths: stableIds(result.plan.scope.changedPaths),
      requiredTaskIds: comparison.required,
      expectedSelectionTaskIds,
      selectedTaskIds: comparison.selected,
      extraTaskIds: comparison.extra,
      falseNegatives: comparison.falseNegatives,
      unexpectedSelection,
      fullFallback: result.plan.scope.fullFallback,
      fullFallbackPolicy: testCase.fullFallbackPolicy,
      fallbackPolicyFailure,
      taskDecisions: result.plan.tasks.map(compactDecision),
      issues: normalizeIssues(result.plan.issues),
      complete: result.plan.complete,
      nativeRun,
    };
  } catch (error) {
    return {
      id: testCase.id,
      ...caseProofContext(testCase),
      classification: testCase.classification,
      description: testCase.description,
      base: frozen.base,
      head: oracleWorkspace?.head ?? null,
      expectedChangedTaskIds: stableIds(testCase.expectedChangedTaskIds),
      outcomes: { baseline: baselineOutcomes, mutated: mutatedOutcomes },
      executionError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    removeWorkspace(oracleWorkspace?.workspace);
    removeWorkspace(nativeWorkspace?.workspace);
    activeCases -= 1;
    completedCases += 1;
    process.stderr.write(
      `soundness completed ${completedCases}/${orderedCases.length}: ${testCase.id}\n`,
    );
  }
}

const falseNegatives = caseResults.flatMap((result) =>
  (result.falseNegatives ?? []).map((taskId) => ({
    caseId: result.id,
    taskId,
  })),
);
const skippedChangedOutcomes = caseResults.flatMap((result) =>
  (result.skippedChangedOutcomes ?? []).map((taskId) => ({
    caseId: result.id,
    taskId,
  })),
);
const unexpectedSelections = caseResults
  .filter((result) => result.unexpectedSelection?.matches === false)
  .map((result) => ({ caseId: result.id, ...result.unexpectedSelection }));
const fallbackPolicyFailures = caseResults
  .filter((result) => result.fallbackPolicyFailure != null)
  .map((result) => ({ caseId: result.id, ...result.fallbackPolicyFailure }));
const executionFailures = caseResults
  .filter((result) => result.executionError !== undefined)
  .map((result) => ({ caseId: result.id, error: result.executionError }));
if (baselineReceipt.executionError)
  executionFailures.push({
    caseId: null,
    phase: "baseline",
    error: baselineReceipt.executionError,
  });
const evidence = {
  baseline: baselineReceipt,
  concurrency: { ...concurrency, peakCases },
  shard: shardReceipt(shard, orderedCases),
  executionCounts,
  timings: { ...timings, totalMs: performance.now() - startedAt },
  schemaVersion: 2,
  kind: "dads-testing-soundness",
  sourceSha,
  toolVersions: {
    ...toolVersions(root),
    dadTestBinarySha256: sha256File(binary),
  },
  corpus: {
    ...corpusContext,
    caseIds: stableIds(corpus.cases.map((result) => result.id)),
    declaredTaskIds: stableIds(corpus.allTaskIds),
    tasks: declaredManifest.tasks.map((task) => ({
      id: task.id,
      dependsOn: task.dependsOn,
    })),
  },
  cases: caseResults,
  issues: caseResults.flatMap((result) =>
    (result.issues ?? []).map((issue) => ({ caseId: result.id, ...issue })),
  ),
  summary: {
    cases: caseResults.length,
    falseNegatives: falseNegatives.length,
    skippedChangedOutcomes: skippedChangedOutcomes.length,
    unexpectedSelections: unexpectedSelections.length,
    fallbackPolicyFailures: fallbackPolicyFailures.length,
    executionFailures: executionFailures.length,
    status:
      falseNegatives.length === 0 &&
      skippedChangedOutcomes.length === 0 &&
      unexpectedSelections.length === 0 &&
      fallbackPolicyFailures.length === 0 &&
      executionFailures.length === 0
        ? "pass"
        : "fail",
  },
  falseNegatives,
  skippedChangedOutcomes,
  unexpectedSelections,
  fallbackPolicyFailures,
  executionFailures,
};
jsonWrite(output, evidence);
process.stdout.write(
  `${JSON.stringify({ ok: evidence.summary.status === "pass", output, summary: evidence.summary })}\n`,
);
if (evidence.summary.status !== "pass") process.exitCode = 1;

function nativeRequest(workspaceRoot, base, head) {
  return {
    schemaVersion: 1,
    operation: "run",
    workspaceRoot,
    manifestPath: "dads.testing.json",
    base,
    head,
    all: false,
    taskIds: [],
    jobs: concurrency.nativeJobs,
  };
}

function assertTaskInventory(taskIds, tasks) {
  const declared = stableIds(tasks.map((task) => task.id));
  if (stableIds(taskIds).join(",") !== declared.join(","))
    throw new Error("Corpus task inventory must match the manifest exactly.");
}

function assertExpectedOutcomes(testCase, changedTaskIds) {
  const expected = stableIds(testCase.expectedChangedTaskIds);
  if (expected.join(",") !== changedTaskIds.join(","))
    throw new Error(
      `${testCase.id} observed ${changedTaskIds.join(",")} but expected ${expected.join(",")}.`,
    );
}

function compactDecision(task) {
  return {
    id: task.id,
    decision: task.decision,
    reason: task.reason,
    confidence: task.confidence,
    causes: task.causes,
  };
}
