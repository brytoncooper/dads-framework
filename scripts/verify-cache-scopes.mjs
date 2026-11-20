/**
 * What each `npm run verify` step reads, for the local verify cache.
 *
 * A step missing from this map is never skipped, so a step added to the graph
 * runs every time until someone says what it reads. Three kinds of entry:
 *
 * - `tree`: the whole checkout, untracked and gitignored inputs included.
 *   Every repo-wide check is here; any change anywhere reruns it.
 * - absent on purpose: `build`, because `tsc -b` is already incremental and
 *   every later step needs its `dist` to be real; `test` and `test-types`,
 *   which cache one package at a time themselves.
 *
 * Build output (`dist`, `*.tsbuildinfo`) is not hashed: the `build` step makes
 * it from the tree on every run before anything reads it.
 */

const TREE = Object.freeze({ kind: "tree" });

export const STEP_CACHE_SCOPES = Object.freeze({
  format: TREE,
  "private-references": TREE,
  eslint: TREE,
  "api-report": TREE,
  docs: TREE,
  "markdown-links": TREE,
  "script-tests": TREE,
  "workbench-client": TREE,
  "dependency-boundaries": TREE,
  invariants: TREE,
  // The `test-count` floor reads the Vitest report the `test` step writes
  // under the gitignored `node_modules/.dads`, so its content is an input.
  "source-budgets": Object.freeze({
    kind: "tree",
    files: ["node_modules/.dads/vitest-report.json"],
    history: true,
  }),
  "instruction-budgets": TREE,
  "agent-benchmarks": TREE,
});

/** The steps with their cache scope attached, where they have one. */
export function withCacheScopes(steps) {
  return steps.map((step) => {
    const cache = STEP_CACHE_SCOPES[step.id];
    return cache === undefined ? step : Object.freeze({ ...step, cache });
  });
}
