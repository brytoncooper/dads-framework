/**
 * Which Vitest target is running.
 *
 * The repo splits one file set into two tiers by FILE SUFFIX: the fast tier
 * (`test`) runs the pure files, the container tier (`test:integration`) runs
 * `*.integration.test.ts` and `*.e2e.test.ts` (docs/testing/speed.md). All 12
 * `test:integration` targets set `VITEST_TIER=integration` and no `test`
 * target sets it, so this one variable is a faithful answer to "will anything
 * in this run touch a real vendor?".
 *
 * The shared globalSetup asks before it boots anything. It used to boot a
 * Postgres and replay 21 migrations for every project that MIGHT run a
 * container test, including on runs where the tier selection had already
 * excluded every such file — `domain-ticketing` spent 51s of wall clock on 69
 * tests whose own execution took 90ms.
 *
 * Skipping the boot cannot break a fast-tier test that turns out to need a
 * database, for two independent reasons. The integration test tier check
 * rejects any test file that imports `startTestPostgres` or a container module
 * without a tier suffix, so such a file cannot sit in the fast tier in the
 * first place; and if one somehow did, `startTestPostgres` falls back to
 * booting its own container when the shared URL is absent. The gate can cost
 * a run time. It cannot cost it a database.
 */

/** Set by every `test:integration` target; unset by every `test` target. */
export const VITEST_TIER = "VITEST_TIER";

/** The one value the 12 `vitest.config.mts` files compare against. */
export const CONTAINER_TEST_TIER = "integration";

/** True when this run selected the files that boot a real vendor. */
export function isContainerTestRun(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[VITEST_TIER] === CONTAINER_TEST_TIER;
}
