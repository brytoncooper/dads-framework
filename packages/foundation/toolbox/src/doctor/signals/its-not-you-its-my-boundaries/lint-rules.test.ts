/** Proves `lint-rules` reports unresolved ESLint scopes as not measured instead of zero. */

import { describe, expect, it } from "vitest";
import type { DoctorContext } from "../../doctor-context.js";
import { lintRulesSignal } from "./lint-rules.js";

function contextOver(files: readonly string[], stdout: string): DoctorContext {
  return {
    root: "/repo",
    today: undefined,
    files: () => files,
    directories: () => [],
    read: () => "",
    exists: () => true,
    packages: () => [],
    exec: () => ({ status: 0, stdout }),
    online: false,
    fetch: () => {
      throw new Error("no network here");
    },
    program: () => {
      throw new Error("no program here");
    },
  };
}

describe("lint-rules signal", () => {
  it("throws when lint scopes cannot be resolved so doctor marks it not measured", () => {
    expect(() => lintRulesSignal.run(contextOver(["README.md"], ""))).toThrow(
      "no lint config scopes",
    );
  });

  it("counts error-level rules across all four resolved scopes", async () => {
    const files = [
      "packages/access/src/index.ts",
      "packages/access/src/index.test.ts",
      "packages/server/http/type-tests/verb-fixture.ts",
      "scripts/checks/check-docs.mjs",
    ];
    const printed = JSON.stringify({
      rules: {
        "no-var": "error",
        "prefer-const": "warn",
      },
    });
    const readings = await lintRulesSignal.run(contextOver(files, printed));

    expect([...readings.keys()].sort()).toStrictEqual([
      "scripts:no-var",
      "source:no-var",
      "test:no-var",
      "type-tests:no-var",
    ]);
  });
});
