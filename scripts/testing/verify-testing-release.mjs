#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { mergeSoundnessShards, sameIds, stableIds } from "./verify-testing-release-merge.mjs";

const SEALED_CORPUS = resolve(import.meta.dirname, "..", "..", "fixtures", "testing-soundness", "cases.json");

/**
 * Reads the one supported option. `--soundness` may be repeated, once per
 * shard of the same corpus run; the files are merged before anything is
 * judged.
 */
export function parseTestingReleaseArguments(argumentsList) {
  if (!Array.isArray(argumentsList)) throw new ReleaseUsageError("arguments must be an array");
  const soundness = [];
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    if (option !== "--soundness") throw new ReleaseUsageError(`unsupported option: ${String(option)}`);
    soundness.push(soundnessPath(argumentsList[index + 1], soundness));
  }
  if (soundness.length === 0) throw new ReleaseUsageError("--soundness is required");
  return { "--soundness": soundness };
}

function soundnessPath(value, taken) {
  if (typeof value !== "string" || value === "" || value.startsWith("--"))
    throw new ReleaseUsageError("--soundness requires a value");
  const path = resolve(value);
  if (taken.includes(path)) throw new ReleaseUsageError(`duplicate --soundness file: ${path}`);
  return path;
}

export function verifyTestingReleaseEvidence(input) {
  const evidence = requireRecord(input, "release evidence");
  const failures = [];
  validateSoundness(evidence.soundness, failures);
  return {
    ok: failures.length === 0,
    failures,
    sourceSha: evidence.soundness?.sourceSha ?? null,
  };
}

export class ReleaseUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseUsageError";
  }
}

export function main(argumentsList) {
  let argumentsByOption;
  try {
    argumentsByOption = parseTestingReleaseArguments(argumentsList);
  } catch (error) {
    return { code: 2, result: failure(errorMessage(error)) };
  }
  try {
    return judge(soundnessInput(argumentsByOption["--soundness"]));
  } catch (error) {
    return { code: 1, result: failure(errorMessage(error)) };
  }
}

/**
 * One evidence file that is not a shard is judged as it was written. Anything
 * else is a sharded corpus run and is merged against the sealed corpus first.
 */
function soundnessInput(paths) {
  const documents = paths.map((path) => ({ path, evidence: readJson(path) }));
  if (documents.length === 1 && documents[0].evidence?.shard == null)
    return { evidence: documents[0].evidence, failures: [] };
  return mergeSoundnessShards(documents, sealedCorpusCaseIds());
}

function judge(merged) {
  if (merged.failures.length > 0)
    return {
      code: 1,
      result: { ok: false, failures: merged.failures, sourceSha: null },
    };
  const result = verifyTestingReleaseEvidence({ soundness: merged.evidence });
  const shards = merged.evidence.shards;
  return {
    code: result.ok ? 0 : 1,
    result: shards === undefined ? result : { ...result, shards: shards.map(shardCount) },
  };
}

function shardCount(shard) {
  return {
    index: shard.index,
    count: shard.count,
    cases: shard.caseIds.length,
  };
}

function sealedCorpusCaseIds() {
  const corpus = readJson(SEALED_CORPUS);
  const cases = Array.isArray(corpus?.cases) ? corpus.cases : [];
  const ids = stableIds(cases.map((testCase) => testCase?.id));
  if (ids.length === 0 || ids.length !== cases.length)
    throw new Error(`sealed corpus ${SEALED_CORPUS} has no unique case ids`);
  return ids;
}

function validateSoundness(soundness, failures) {
  if (soundness?.kind !== "dads-testing-soundness") failures.push("soundness evidence has the wrong kind");
  if (soundness?.schemaVersion !== 2) failures.push("soundness evidence is not executed-proof schema version 2");
  if (
    soundness?.summary?.status !== "pass" ||
    Number(soundness?.summary?.falseNegatives) !== 0 ||
    (soundness?.falseNegatives?.length ?? 0) !== 0
  )
    failures.push("soundness corpus contains a false-negative or did not pass");
  if (Number(soundness?.summary?.unexpectedSelections) !== 0 || (soundness?.unexpectedSelections?.length ?? 0) !== 0)
    failures.push("soundness corpus detected a precision-case selection mismatch");
  if (
    Number(soundness?.summary?.fallbackPolicyFailures) !== 0 ||
    (soundness?.fallbackPolicyFailures?.length ?? 0) !== 0
  )
    failures.push("soundness corpus detected an unexpected precision collapse or missing conservative fallback");
  if (
    Number(soundness?.summary?.skippedChangedOutcomes) !== 0 ||
    (soundness?.skippedChangedOutcomes?.length ?? 0) !== 0
  ) {
    failures.push("soundness corpus skipped a task with a changed outcome");
  }
  if (Number(soundness?.summary?.executionFailures) !== 0 || (soundness?.executionFailures?.length ?? 0) !== 0) {
    failures.push("soundness corpus has an incomplete executed case");
  }
  validateExecutedCases(soundness, failures);
}

function validateExecutedCases(soundness, failures) {
  const taskIds = stableIds(soundness?.corpus?.declaredTaskIds);
  const cases = soundness?.cases;
  if (taskIds.length === 0 || !Array.isArray(cases) || cases.length === 0) {
    failures.push("soundness evidence has no executed task inventory or cases");
    return;
  }
  if (Number(soundness?.summary?.cases) !== cases.length)
    failures.push("soundness summary does not match executed case count");
  const caseIds = cases.map((testCase) => testCase?.id);
  if (!sameIds(caseIds, soundness?.corpus?.caseIds) || new Set(caseIds).size !== cases.length)
    failures.push("soundness corpus case inventory is incomplete or duplicated");
  const dependencies = dependencyMap(soundness?.corpus?.tasks, taskIds, failures);
  for (const testCase of cases) validateExecutedCase(testCase, taskIds, dependencies, failures);
}

function validateExecutedCase(testCase, taskIds, dependencies, failures) {
  if (typeof testCase?.id !== "string") {
    failures.push("soundness evidence has a case without an id");
    return;
  }
  const label = `soundness case ${testCase.id}`;
  const baseline = taskMap(testCase?.outcomes?.baseline, taskIds, `${label} baseline`, failures);
  const mutated = taskMap(testCase?.outcomes?.mutated, taskIds, `${label} mutation`, failures);
  const decisions = taskMap(testCase?.taskDecisions, taskIds, `${label} decisions`, failures);
  const receipts = taskMap(testCase?.nativeRun?.tasks, taskIds, `${label} native receipts`, failures);
  if (!baseline || !mutated || !decisions || !receipts) return;
  const changed = [];
  const failed = [];
  for (const id of taskIds) {
    const before = baseline.get(id);
    const after = mutated.get(id);
    if (before.status !== "passed" || before.exitCode !== 0)
      failures.push(`${label} has an invalid baseline outcome for ${id}`);
    if (!validObservedOutcome(after)) failures.push(`${label} has an incomplete mutation outcome for ${id}`);
    if (`${before.status}:${String(before.exitCode)}` !== `${after.status}:${String(after.exitCode)}`) changed.push(id);
    if (after.status === "failed") failed.push(id);
    const selected = decisions.get(id).decision === "run";
    const receipt = receipts.get(id);
    if (!selected && receipt.status !== "not-applicable") failures.push(`${label} executed skipped task ${id}`);
    if (selected && !["executed", "failed", "blocked"].includes(receipt.status))
      failures.push(`${label} lacks a valid selected-run receipt for ${id}`);
  }
  if (!sameIds(changed, testCase.changedTaskIds))
    failures.push(`${label} changed outcomes do not match recorded outcomes`);
  if (!sameIds(failed, testCase.failedTaskIds))
    failures.push(`${label} failed outcomes do not match recorded failures`);
  const selected = taskIds.filter((id) => decisions.get(id).decision === "run");
  if (taskIds.some((id) => !["run", "skip-proven-unaffected"].includes(decisions.get(id).decision))) {
    failures.push(`${label} has an invalid decision`);
  }
  if (!["breaking", "control"].includes(testCase.classification))
    failures.push(`${label} has an invalid classification`);
  if (testCase.classification === "control" && changed.length !== 0)
    failures.push(`${label} control case changed a task outcome`);
  if (testCase.classification === "breaking" && changed.length === 0)
    failures.push(`${label} breaking case observed no changed task outcome`);
  if (!sameIds(changed, testCase.expectedChangedTaskIds))
    failures.push(`${label} changed outcomes differ from its declared expectation`);
  if (!sameIds([], testCase.skippedChangedOutcomes)) failures.push(`${label} skipped a changed task outcome`);
  if (changed.some((id) => !selected.includes(id)))
    failures.push(`${label} selected plan omitted a changed task outcome`);
  validateNativeRun(testCase?.nativeRun, selected, dependencies, mutated, label, failures);
}

function dependencyMap(tasks, taskIds, failures) {
  if (!Array.isArray(tasks)) {
    failures.push("soundness evidence has no task dependency inventory");
    return new Map();
  }
  const result = new Map();
  for (const task of tasks) {
    if (typeof task?.id !== "string" || !Array.isArray(task.dependsOn) || result.has(task.id)) {
      failures.push("soundness task dependency inventory is invalid");
      return new Map();
    }
    result.set(task.id, task.dependsOn);
  }
  if (!sameIds([...result.keys()], taskIds)) failures.push("soundness task dependency inventory does not cover tasks");
  return result;
}

function validateNativeRun(nativeRun, selected, dependencies, outcomes, label, failures) {
  const receipts = new Map(nativeRun?.tasks?.map((task) => [task.id, task]));
  let failed = 0;
  let blocked = 0;
  let executed = 0;
  let notApplicable = 0;
  for (const [id, receipt] of receipts) {
    if (receipt.status === "failed") failed += 1;
    if (receipt.status === "blocked") blocked += 1;
    if (["executed", "failed"].includes(receipt.status)) executed += 1;
    if (receipt.status === "not-applicable") notApplicable += 1;
    if (
      receipt.status === "blocked" &&
      !(dependencies.get(id) ?? []).some((dependency) =>
        ["failed", "blocked"].includes(receipts.get(dependency)?.status),
      )
    ) {
      failures.push(`${label} blocked task ${id} has no failed prerequisite`);
    }
    if (!selected.includes(id) || receipt.status === "blocked") continue;
    const outcome = outcomes.get(id);
    const expectedStatus = outcome.status === "passed" ? "executed" : "failed";
    if (receipt.status !== expectedStatus || receipt.exitCode !== outcome.exitCode)
      failures.push(`${label} native receipt disagrees with outcome for ${id}`);
    for (const dependency of dependencies.get(id) ?? []) {
      if (!selected.includes(dependency))
        failures.push(`${label} selected task ${id} omitted prerequisite ${dependency}`);
    }
  }
  if (
    nativeRun?.counts?.failed !== failed ||
    nativeRun?.counts?.blocked !== blocked ||
    nativeRun?.counts?.executed !== executed ||
    nativeRun?.counts?.notApplicable !== notApplicable ||
    nativeRun?.exitCode !== (failed > 0 || blocked > 0 ? 1 : 0)
  )
    failures.push(`${label} native run counts or exit code are invalid`);
}

function taskMap(values, taskIds, label, failures) {
  if (!Array.isArray(values)) {
    failures.push(`${label} are missing`);
    return null;
  }
  const map = new Map();
  for (const value of values) {
    if (typeof value?.id !== "string" || map.has(value.id)) {
      failures.push(`${label} are invalid`);
      return null;
    }
    map.set(value.id, value);
  }
  if (!sameIds([...map.keys()], taskIds)) {
    failures.push(`${label} do not cover the declared task inventory`);
    return null;
  }
  return map;
}

function validObservedOutcome(outcome) {
  return (
    Number.isInteger(outcome.exitCode) &&
    ((outcome.status === "passed" && outcome.exitCode === 0) || (outcome.status === "failed" && outcome.exitCode !== 0))
  );
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function failure(message) {
  return { ok: false, failures: [message], sourceSha: null };
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const response = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(response.result)}\n`);
  process.exitCode = response.code;
}
