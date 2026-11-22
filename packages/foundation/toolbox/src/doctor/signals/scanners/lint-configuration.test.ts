/**
 * What `eslint --print-config` is asked, and what is done with silence.
 *
 * Two readings share these probes — the floor under the error-level rules and
 * the ceiling over the ones left at `warn` — so the thing worth pinning is the
 * shape of the answer: a rule counts under the scope of the probe it was
 * resolved for, and a probe that cannot be resolved at all means no answer
 * rather than a partial one. A partial set reads as a pile of removed rules to
 * the floor and as a clean repository to the ceiling, which is the worst of
 * both.
 */

import { describe, expect, it } from "vitest";
import type { DoctorContext } from "../../doctor-context.js";
import { resolveLintScopes, rulesAtSeverity } from "./lint-configuration.js";

const PROBES = [
  "packages/http/core/src/index.ts",
  "packages/http/core/src/route/route-behavior.test.ts",
  "packages/http/core/type-tests/route-cards.ts",
  "scripts/checks/check-docs.mjs",
];

const PRINTED = JSON.stringify({
  rules: {
    "no-undef": 2,
    "@typescript-eslint/no-explicit-any": ["error", {}],
    "prefer-const": "warn",
    "no-console": 0,
  },
});

function contextOver(files: readonly string[], asked: string[]): DoctorContext {
  return {
    root: "/repo",
    today: undefined,
    files: () => files,
    directories: () => [],
    read: () => "",
    exists: () => true,
    packages: () => [],
    exec: (_command, commandArguments) => {
      asked.push(commandArguments[2] ?? "");
      return { status: 0, stdout: PRINTED };
    },
    online: false,
    fetch: () => {
      throw new Error("no network here");
    },
    program: () => {
      throw new Error("no program here");
    },
  };
}

describe("the resolved lint configuration", () => {
  it("reads one probe per scope and keeps the severity it resolved", () => {
    const asked: string[] = [];
    const scopes = resolveLintScopes(contextOver(PROBES, asked));

    expect(asked).toStrictEqual(PROBES);
    expect(scopes.map((scope) => scope.scope)).toStrictEqual([
      "source",
      "test",
      "type-tests",
      "scripts",
    ]);
    expect(
      rulesAtSeverity(scopes[0] ?? { scope: "", path: "", rules: {} }, "error"),
    ).toStrictEqual(["@typescript-eslint/no-explicit-any", "no-undef"]);
    expect(
      rulesAtSeverity(scopes[0] ?? { scope: "", path: "", rules: {} }, "warn"),
    ).toStrictEqual(["prefer-const"]);
  });

  it("answers nothing at all when a probe cannot be resolved", () => {
    const asked: string[] = [];
    const scopes = resolveLintScopes(
      contextOver(["packages/http/core/src/index.ts"], asked),
    );

    expect(scopes).toStrictEqual([]);
  });

  it("resolves probes through fallback patterns for the standalone package layout", () => {
    const asked: string[] = [];
    const standaloneProbes = [
      "packages/access/src/core/access-model.ts",
      "packages/access/src/core/emit-zed.test.ts",
      "packages/server/http/type-tests/verb-execution.test.ts",
      "packages/server/http/type-tests/verb-fixture.ts",
      "scripts/checks/custom-check.mjs",
    ];
    const scopes = resolveLintScopes(contextOver(standaloneProbes, asked));

    expect(asked).toStrictEqual([
      "packages/access/src/core/access-model.ts",
      "packages/access/src/core/emit-zed.test.ts",
      "packages/server/http/type-tests/verb-fixture.ts",
      "scripts/checks/custom-check.mjs",
    ]);
    expect(scopes.map((scope) => scope.scope)).toStrictEqual([
      "source",
      "test",
      "type-tests",
      "scripts",
    ]);
  });

  it("answers nothing when eslint --print-config returns empty stdout", () => {
    const context: DoctorContext = {
      ...contextOver(PROBES, []),
      exec: () => ({ status: 0, stdout: "" }),
    };

    expect(resolveLintScopes(context)).toStrictEqual([]);
  });
});
