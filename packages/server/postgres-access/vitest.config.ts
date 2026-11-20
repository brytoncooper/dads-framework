import { configDefaults, defineConfig } from "vitest/config";

const tier = process.env["VITEST_TIER"];
const suites = {
  integration: ["src/**/*.integration.test.ts"],
  benchmark: ["src/**/*.benchmark.test.ts"],
};

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include:
      tier === "integration" || tier === "benchmark"
        ? suites[tier]
        : ["src/**/*.test.ts"],
    exclude:
      tier === "integration" || tier === "benchmark"
        ? [...configDefaults.exclude, "**/dist/**"]
        : [
            ...configDefaults.exclude,
            "**/dist/**",
            ...suites.integration,
            ...suites.benchmark,
          ],
  },
});
