/**
 * What: compile-time contract checks for providePlugin.
 * Why: negative type assertions live under type-tests/ so the type checker
 * proves mismatched service implementations fail to compile.
 */
import { describe, expect, it } from "vitest";

import { defineService } from "../define-service.js";
import { providePlugin } from "../provide-plugin.js";

type Clock = {
  readonly now: () => number;
};

const clockService = defineService("clock").ofType<Clock>();

describe("providePlugin — compile-time contract", () => {
  it("refuses a value that does not implement the service at compile time", () => {
    const check = () => {
      providePlugin(
        "broken-clock",
        clockService,
        // @ts-expect-error return value omits the required `now` method from Clock
        () => ({ label: "not-a-clock" }),
      );
    };
    expect(typeof check).toBe("function");
  });
});
