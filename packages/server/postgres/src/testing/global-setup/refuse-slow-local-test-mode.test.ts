import { describe, expect, it } from "vitest";
import {
  ALLOW_SLOW_TEST_MODE,
  SLOW_LOCAL_TEST_MODE_MESSAGE,
  VITEST_ISOLATE,
  refuseSlowLocalTestMode,
} from "./refuse-slow-local-test-mode.js";

/**
 * Local CONTAINER_PER_FILE / VITEST_ISOLATE is the hour-long honesty path.
 * Agents must hit a loud refuse, not sit on a --all boot-per-file run.
 */
describe("refuseSlowLocalTestMode", () => {
  it("allows the default daytime path", () => {
    expect(() => {
      refuseSlowLocalTestMode({});
    }).not.toThrow();
  });

  it("refuses a local container-per-file run", () => {
    expect(() => {
      refuseSlowLocalTestMode({ CONTAINER_PER_FILE: "1" });
    }).toThrow(SLOW_LOCAL_TEST_MODE_MESSAGE);
  });

  it("refuses a local isolate-everywhere run", () => {
    expect(() => {
      refuseSlowLocalTestMode({ [VITEST_ISOLATE]: "1" });
    }).toThrow(/honesty job/);
  });

  it("exempts CI, which owns the nightly honesty jobs", () => {
    expect(() => {
      refuseSlowLocalTestMode({ CONTAINER_PER_FILE: "1", CI: "true" });
    }).not.toThrow();
    expect(() => {
      refuseSlowLocalTestMode({ [VITEST_ISOLATE]: "1", CI: "true" });
    }).not.toThrow();
  });

  it("allows an explicit local override", () => {
    expect(() => {
      refuseSlowLocalTestMode({
        CONTAINER_PER_FILE: "1",
        [ALLOW_SLOW_TEST_MODE]: "1",
      });
    }).not.toThrow();
  });
});
