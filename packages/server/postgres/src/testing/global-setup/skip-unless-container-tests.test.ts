import { describe, expect, it } from "vitest";
import {
  CONTAINER_TEST_TIER,
  VITEST_TIER,
  isContainerTestRun,
} from "./skip-unless-container-tests.js";

/**
 * The gate that decides whether a run boots the shared stack at all. Every
 * `test:integration` target sets this variable and no `test` target does, so
 * reading it exactly as the 12 `vitest.config.mts` files read it is the whole
 * correctness argument.
 */
describe("isContainerTestRun", () => {
  it("is the container tier when the target set the variable", () => {
    expect(isContainerTestRun({ [VITEST_TIER]: CONTAINER_TEST_TIER })).toBe(
      true,
    );
  });

  it("is the fast tier when the variable is absent", () => {
    expect(isContainerTestRun({})).toBe(false);
  });

  it("matches the value exactly, as the vitest configs do", () => {
    // The configs compare `=== "integration"`. Anything looser here and the
    // harness and the file selection would disagree about which tier is
    // running — the stack would boot for a run with no container test in it,
    // or worse, not boot for a run full of them.
    expect(isContainerTestRun({ [VITEST_TIER]: "Integration" })).toBe(false);
    expect(isContainerTestRun({ [VITEST_TIER]: "integration " })).toBe(false);
    expect(isContainerTestRun({ [VITEST_TIER]: "1" })).toBe(false);
    expect(isContainerTestRun({ [VITEST_TIER]: "" })).toBe(false);
  });
});
