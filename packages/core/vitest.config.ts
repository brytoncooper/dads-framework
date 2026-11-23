import { configDefaults, defineConfig } from "vitest/config";

/** The container tier: suites that need a real vendor behind them. */
const TIER_FILES = ["**/*.integration.test.ts", "**/*.e2e.test.ts"];
const INTEGRATION_TIER = process.env["VITEST_TIER"] === "integration";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    // `node` is the default; a file that needs a DOM opts in with a
    // `// @vitest-environment jsdom` docblock.
    environment: "node",
    include: INTEGRATION_TIER ? TIER_FILES : ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: [...configDefaults.exclude, "**/dist/**", ...(INTEGRATION_TIER ? [] : TIER_FILES)],
  },
});
