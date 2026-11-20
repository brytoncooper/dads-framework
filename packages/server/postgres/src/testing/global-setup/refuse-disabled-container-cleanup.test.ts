import { describe, expect, it } from "vitest";
import {
  TESTCONTAINERS_RYUK_DISABLED,
  refuseDisabledContainerCleanup,
} from "./refuse-disabled-container-cleanup.js";

/**
 * The reaper wall is the only cleanup that survives a `kill -9`, so the switch
 * that turns it off is refused for local runs. CI is exempt: a runner is a
 * fresh VM destroyed after the job, so its containers die with the box.
 */
describe("refuseDisabledContainerCleanup", () => {
  it("refuses a local run that disabled the reaper", () => {
    expect(() => {
      refuseDisabledContainerCleanup({
        [TESTCONTAINERS_RYUK_DISABLED]: "true",
      });
    }).toThrow(/TESTCONTAINERS_RYUK_DISABLED/);
  });

  it("allows the default, where the variable is absent", () => {
    expect(() => {
      refuseDisabledContainerCleanup({});
    }).not.toThrow();
  });

  it("allows any value other than the literal 'true' testcontainers reads", () => {
    // testcontainers compares against the string "true" and nothing else, so
    // this wall must read the switch exactly as the library does — no
    // truthiness, no "1", no case folding.
    expect(() => {
      refuseDisabledContainerCleanup({
        [TESTCONTAINERS_RYUK_DISABLED]: "false",
      });
    }).not.toThrow();
    expect(() => {
      refuseDisabledContainerCleanup({ [TESTCONTAINERS_RYUK_DISABLED]: "1" });
    }).not.toThrow();
    expect(() => {
      refuseDisabledContainerCleanup({
        [TESTCONTAINERS_RYUK_DISABLED]: "TRUE",
      });
    }).not.toThrow();
  });

  it("exempts CI, whose runners are destroyed with their containers", () => {
    expect(() => {
      refuseDisabledContainerCleanup({
        [TESTCONTAINERS_RYUK_DISABLED]: "true",
        CI: "true",
      });
    }).not.toThrow();
  });

  it("tells the reader what the switch costs, not just that it is refused", () => {
    expect(() => {
      refuseDisabledContainerCleanup({
        [TESTCONTAINERS_RYUK_DISABLED]: "true",
      });
    }).toThrow(/outlive/);
  });
});
