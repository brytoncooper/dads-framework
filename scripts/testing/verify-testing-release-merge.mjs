/**
 * Merging sharded soundness evidence back into one corpus run.
 *
 * A shard proves its own slice. The release gate judges the corpus, so before
 * judging anything the shards have to add back up to it: same source, same
 * tools, same baseline, every sealed case run exactly once. Anything short of
 * that is a failure with the missing or repeated case ids named, because a
 * quietly dropped shard would otherwise read as a clean run of a smaller
 * corpus — which is the one thing the gate exists to refuse.
 */

/**
 * What every shard of one corpus run must report identically. The baseline is
 * compared by the fingerprints of what was frozen, not by the whole receipt:
 * each shard freezes its own Git workspace, so the commit id and the recorded
 * durations and diagnostics differ by construction while the content does not.
 */
const AGREED_FIELDS = [
  { name: "sourceSha", of: (evidence) => evidence.sourceSha },
  { name: "toolVersions", of: (evidence) => evidence.toolVersions },
  { name: "corpus", of: (evidence) => evidence.corpus },
  {
    name: "baseline",
    of: (evidence) => ({
      tree: evidence.baseline?.tree ?? null,
      manifestSha256: evidence.baseline?.manifestSha256 ?? null,
    }),
  },
];
const SUMMED_COUNTS = [
  "cases",
  "falseNegatives",
  "skippedChangedOutcomes",
  "unexpectedSelections",
  "fallbackPolicyFailures",
  "executionFailures",
];
const MERGED_LISTS = [
  "falseNegatives",
  "skippedChangedOutcomes",
  "unexpectedSelections",
  "fallbackPolicyFailures",
  "executionFailures",
  "issues",
];

/**
 * Merges shard evidence documents (`{ path, evidence }`) into one soundness
 * document covering `sealedCaseIds`, or reports why they do not add up.
 */
export function mergeSoundnessShards(documents, sealedCaseIds) {
  const failures = [];
  const shards = documents.map((document) => shardRecord(document, failures));
  if (failures.length > 0) return { evidence: null, failures };
  checkAgreement(shards, failures);
  checkCoverage(shards, sealedCaseIds, failures);
  if (failures.length > 0) return { evidence: null, failures };
  return { evidence: mergedEvidence(shards), failures };
}

export function stableIds(values) {
  return Array.isArray(values)
    ? [...new Set(values)].sort((left, right) =>
        String(left).localeCompare(String(right)),
      )
    : [];
}

export function sameIds(left, right) {
  return stableIds(left).join(",") === stableIds(right).join(",");
}

function shardRecord({ path, evidence }, failures) {
  const label = `soundness shard ${path}`;
  if (
    evidence?.kind !== "dads-testing-soundness" ||
    evidence?.schemaVersion !== 2
  ) {
    failures.push(`${label} is not schema version 2 soundness evidence`);
    return null;
  }
  if (!isShardReceipt(evidence.shard)) {
    failures.push(`${label} has no shard receipt to merge`);
    return null;
  }
  const caseIds = (evidence.cases ?? []).map((testCase) => testCase?.id);
  if (!sameIds(caseIds, evidence.shard.caseIds))
    failures.push(`${label} ran cases its shard receipt does not declare`);
  return { path, evidence, shard: evidence.shard, caseIds };
}

function isShardReceipt(shard) {
  return (
    shard !== null &&
    typeof shard === "object" &&
    Number.isSafeInteger(shard.index) &&
    Number.isSafeInteger(shard.count) &&
    shard.index >= 1 &&
    shard.index <= shard.count &&
    Array.isArray(shard.caseIds) &&
    shard.caseIds.every((id) => typeof id === "string")
  );
}

function checkAgreement(shards, failures) {
  for (const field of AGREED_FIELDS) {
    const values = new Set(
      shards.map((shard) => JSON.stringify(field.of(shard.evidence) ?? null)),
    );
    if (values.size > 1)
      failures.push(`soundness shards disagree on ${field.name}`);
  }
  const counts = new Set(shards.map((shard) => shard.shard.count));
  if (counts.size > 1)
    failures.push("soundness shards disagree on the shard count");
  const indexes = shards.map((shard) => shard.shard.index);
  if (new Set(indexes).size !== indexes.length)
    failures.push("soundness shards repeat a shard index");
}

function checkCoverage(shards, sealedCaseIds, failures) {
  const executed = new Set();
  const repeated = [];
  for (const shard of shards) {
    for (const id of shard.caseIds) {
      if (executed.has(id)) repeated.push(id);
      executed.add(id);
    }
  }
  if (repeated.length > 0)
    failures.push(
      `soundness shards ran the same case twice: ${stableIds(repeated).join(", ")}`,
    );
  reportCoverageGaps(executed, sealedCaseIds, failures);
}

function reportCoverageGaps(executed, sealedCaseIds, failures) {
  const missing = sealedCaseIds.filter((id) => !executed.has(id));
  if (missing.length > 0)
    failures.push(
      `soundness shards did not run corpus cases: ${missing.join(", ")}`,
    );
  const unknown = [...executed].filter((id) => !sealedCaseIds.includes(id));
  if (unknown.length > 0)
    failures.push(
      `soundness shards ran cases outside the sealed corpus: ${stableIds(unknown).join(", ")}`,
    );
}

function mergedEvidence(shards) {
  const first = shards[0].evidence;
  const merged = {
    schemaVersion: first.schemaVersion,
    kind: first.kind,
    sourceSha: first.sourceSha,
    toolVersions: first.toolVersions,
    baseline: first.baseline,
    corpus: first.corpus,
    shard: null,
    shards: shards.map(shardSummary),
    cases: mergedCases(shards),
    summary: mergedSummary(shards),
  };
  for (const field of MERGED_LISTS)
    merged[field] = shards.flatMap((shard) => shard.evidence[field] ?? []);
  return merged;
}

function shardSummary(shard) {
  return {
    index: shard.shard.index,
    count: shard.shard.count,
    caseIds: stableIds(shard.caseIds),
    source: shard.path,
    concurrency: shard.evidence.concurrency ?? null,
    timings: shard.evidence.timings ?? null,
    executionCounts: shard.evidence.executionCounts ?? null,
  };
}

function mergedCases(shards) {
  return shards
    .flatMap((shard) => shard.evidence.cases ?? [])
    .sort((left, right) => String(left?.id).localeCompare(String(right?.id)));
}

function mergedSummary(shards) {
  const summary = { status: mergedStatus(shards) };
  for (const field of SUMMED_COUNTS) {
    summary[field] = shards.reduce(
      (total, shard) => total + Number(shard.evidence.summary?.[field]),
      0,
    );
  }
  return summary;
}

function mergedStatus(shards) {
  return shards.every((shard) => shard.evidence.summary?.status === "pass")
    ? "pass"
    : "fail";
}
