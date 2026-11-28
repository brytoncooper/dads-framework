import process from "node:process";

/**
 * Environment variable set to `"1"` by `dad-test` whenever it invokes Vitest
 * with explicit narrowed file arguments.
 */
export const DADS_TEST_EXPLICIT_FILES_ENV = "DADS_TEST_EXPLICIT_FILES";

/**
 * Canonical integration and e2e test file globs separated from the fast unit
 * tier when a Vitest project splits unit and container/e2e suites.
 */
export const DADS_DEFAULT_INTEGRATION_PATTERNS: readonly string[] = [
  "**/*.integration.test.ts",
  "**/*.integration.test.tsx",
  "**/*.e2e.test.ts",
  "**/*.e2e.test.tsx",
];

const DEFAULT_BASE_EXCLUDE: readonly string[] = ["**/node_modules/**", "**/dist/**"];
const DEFAULT_UNIT_INCLUDE: readonly string[] = ["src/**/*.test.ts", "src/**/*.test.tsx"];
const EXPLICIT_FILES_INCLUDE: readonly string[] = ["**/*.{test,spec}.{ts,tsx,mts,mjs,js,jsx}"];

export type DadsVitestTierOptions = {
  /**
   * Which tier this config serves when invoked directly without
   * `DADS_TEST_EXPLICIT_FILES=1`:
   * - `"auto"` (default): switches between unit and integration via `VITEST_TIER === "integration"`
   * - `"unit"`: unit-only config (e.g., a root `vitest-files` batch config)
   * - `"integration"`: integration-only config
   */
  readonly tier?: "auto" | "unit" | "integration";
  readonly unitInclude?: readonly string[];
  readonly integrationInclude?: readonly string[];
  readonly baseExclude?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type DadsVitestTierSelection = {
  readonly include: string[];
  readonly exclude: string[];
  readonly isIntegration: boolean;
  readonly isExplicitFiles: boolean;
};

/**
 * Computes Vitest `include` / `exclude` patterns with `dad-test` as the single
 * source of truth:
 *
 * - When `DADS_TEST_EXPLICIT_FILES=1` is set (narrowed `dad-test` run or
 *   `vitest-files` batch), Vitest never re-filters explicit CLI file arguments
 *   through tier exclusions.
 * - Otherwise (direct `npx vitest run` or widened runs), it applies the
 *   canonical unit/integration tier split consistently.
 */
function isIntegrationTier(
  tier: "auto" | "unit" | "integration",
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (tier === "integration") {
    return true;
  }
  return tier === "auto" && env["VITEST_TIER"] === "integration";
}

export function dadsVitestTier(options: DadsVitestTierOptions = {}): DadsVitestTierSelection {
  const env = options.env ?? process.env;
  const baseExclude = [...(options.baseExclude ?? DEFAULT_BASE_EXCLUDE)];
  const integrationInclude = [...(options.integrationInclude ?? DADS_DEFAULT_INTEGRATION_PATTERNS)];
  const unitInclude = [...(options.unitInclude ?? DEFAULT_UNIT_INCLUDE)];
  const isIntegration = isIntegrationTier(options.tier ?? "auto", env);

  if (env[DADS_TEST_EXPLICIT_FILES_ENV] === "1") {
    return {
      include: [...EXPLICIT_FILES_INCLUDE],
      exclude: baseExclude,
      isIntegration,
      isExplicitFiles: true,
    };
  }

  return isIntegration
    ? { include: integrationInclude, exclude: baseExclude, isIntegration: true, isExplicitFiles: false }
    : {
        include: unitInclude,
        exclude: [...baseExclude, ...integrationInclude],
        isIntegration: false,
        isExplicitFiles: false,
      };
}
