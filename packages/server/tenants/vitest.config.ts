import { configDefaults, defineConfig } from "vitest/config";

const integration = process.env["VITEST_TIER"] === "integration";
const tier = ["**/*.integration.test.ts"];

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: integration ? tier : ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...(integration ? [] : tier)],
  },
});
