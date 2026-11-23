// A cancelled caller must not hide a genuine cleanup failure or its recovery guidance.
import { describe, expect, it } from "vitest";
import { describeDevelopmentFailure } from "./describe-development-failure.js";
import { WorkbenchInfrastructureError } from "./docker-infrastructure.js";

describe("development failure diagnostics", () => {
  it("reports the requested cancellation without its private reason", () => {
    const controller = new AbortController();
    const reason = new Error("private cancellation details");
    controller.abort(reason);
    expect(describeDevelopmentFailure(reason, controller.signal)).toEqual({
      message: "Workbench command cancelled.",
      exitCode: 130,
    });
  });

  it("preserves infrastructure failures despite a cancelled caller", () => {
    const controller = new AbortController();
    controller.abort();
    const failure = new WorkbenchInfrastructureError("COMMAND_FAILED");
    expect(describeDevelopmentFailure(failure, controller.signal)).toEqual({
      message: failure.message,
      exitCode: 1,
    });
  });

  it("preserves safe recovery guidance for failed cleanup and timeouts", () => {
    const controller = new AbortController();
    controller.abort();
    for (const error of [new AggregateError([new Error("private error")]), new Error("private timeout")]) {
      const failure = describeDevelopmentFailure(error, controller.signal);
      expect(failure.exitCode).toBe(1);
      expect(failure.message).toContain("run workbench:stop");
      expect(failure.message).not.toContain("private");
    }
  });
});
