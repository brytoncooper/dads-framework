/**
 * Splitting the corpus across runners.
 *
 * A shard is a slice of the same sealed corpus, not a smaller corpus: nothing
 * is skipped, cached, or reused, so every case still runs on exactly one
 * runner every time. The partition is deterministic and needs no coordination
 * between runners: sort the case ids, then deal them out round robin, which
 * keeps neighbouring (and therefore similarly shaped) cases in different
 * shards. `verify-testing-release.mjs` merges the shard evidence and refuses
 * anything that is not the whole corpus exactly once.
 */

const SHARD_PATTERN = /^([1-9][0-9]*)\/([1-9][0-9]*)$/;

/** Parses `--shard <index>/<count>`, 1-based, or null when it was not given. */
export function parseShardOption(value) {
  if (value === undefined) return null;
  const match = SHARD_PATTERN.exec(value);
  if (match === null) throw new Error(`Shard must be <index>/<count> with positive integers: ${value}`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count))
    throw new Error(`Shard ${value} is not a pair of safe integers.`);
  if (index > count) throw new Error(`Shard index ${index} is outside 1..${count}.`);
  return { index, count };
}

/** The cases this shard owns, sorted by id; every case when shard is null. */
export function shardCases(cases, shard) {
  const ordered = [...cases].sort((left, right) => left.id.localeCompare(right.id));
  if (shard === null) return ordered;
  const owned = [];
  for (let position = 0; position < ordered.length; position += 1) {
    if (position % shard.count === shard.index - 1) owned.push(ordered[position]);
  }
  return owned;
}

/** The receipt an evidence file records: null, or the shard and what it ran. */
export function shardReceipt(shard, cases) {
  if (shard === null) return null;
  return {
    index: shard.index,
    count: shard.count,
    caseIds: cases.map((testCase) => testCase.id),
  };
}
