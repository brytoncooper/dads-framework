import { describe, expect, it } from "vitest";
import {
  DADS_DEFAULT_INTEGRATION_PATTERNS,
  DADS_TEST_EXPLICIT_FILES_ENV,
  dadsVitestTier,
} from "./dads-vitest-tier.js";

describe("dadsVitestTier", () => {
  it("excludes integration and e2e patterns by default in unit mode", () => {
    const tier = dadsVitestTier({ env: {} });
    expect(tier.isIntegration).toBe(false);
    expect(tier.isExplicitFiles).toBe(false);
    expect(tier.include).toEqual(["src/**/*.test.ts", "src/**/*.test.tsx"]);
    expect(tier.exclude).toEqual([
      "**/node_modules/**",
      "**/dist/**",
      ...DADS_DEFAULT_INTEGRATION_PATTERNS,
    ]);
  });

  it("switches to integration patterns when VITEST_TIER=integration", () => {
    const tier = dadsVitestTier({ env: { VITEST_TIER: "integration" } });
    expect(tier.isIntegration).toBe(true);
    expect(tier.isExplicitFiles).toBe(false);
    expect(tier.include).toEqual([...DADS_DEFAULT_INTEGRATION_PATTERNS]);
    expect(tier.exclude).toEqual(["**/node_modules/**", "**/dist/**"]);
  });

  it("stops filtering explicit CLI files when DADS_TEST_EXPLICIT_FILES=1", () => {
    const tier = dadsVitestTier({
      tier: "unit",
      env: { [DADS_TEST_EXPLICIT_FILES_ENV]: "1" },
    });
    expect(tier.isExplicitFiles).toBe(true);
    expect(tier.include).toEqual(["**/*.{test,spec}.{ts,tsx,mts,mjs,js,jsx}"]);
    expect(tier.exclude).toEqual(["**/node_modules/**", "**/dist/**"]);
  });

  it("respects custom unitInclude and baseExclude", () => {
    const tier = dadsVitestTier({
      tier: "unit",
      unitInclude: ["src/**/*.test.ts"],
      baseExclude: ["**/node_modules/**", "**/dist/**", "**/generated/**"],
      env: {},
    });
    expect(tier.include).toEqual(["src/**/*.test.ts"]);
    expect(tier.exclude).toEqual([
      "**/node_modules/**",
      "**/dist/**",
      "**/generated/**",
      ...DADS_DEFAULT_INTEGRATION_PATTERNS,
    ]);
  });
});
